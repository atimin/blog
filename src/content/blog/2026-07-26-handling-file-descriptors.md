---
title: "Durable Handling of File Descriptors"
description: 'Why naive open/close semantics break durability and remote storage, and what that means for a database engine.'
draft: false
tags:
    - system-design
    - database
pubDate: '2026-07-26'
slug: 'handling-file-descriptors'
---

In the [previous article](/efficient-data-logger-design) we described the block-based layout behind [ReductStore's storage engine](https://www.reduct.store): append-only blocks, descriptors, and a WAL for crash recovery. In this article, we move to a lower level and examine how ReductStore manages file descriptors to balance durability and performance.


## The cost of durability

The textbook lifecycle of a file is the same across operating systems and languages:

```text
open → write → close
```

This works for the vast majority of applications, but not for databases. When `close()` returns, the kernel has accepted the data into its page cache, but nothing guarantees the data has reached persistent storage. A power failure at this point can lose everything written since the last flush.

The standard fix is to call `fsync` (or `fdatasync`) before closing:

```text
open → write → fsync → close
```

`fsync` forces the kernel to write any modified file data still cached in memory to the storage device and wait for the write to complete. After `fsync` returns, the data is durable — it will survive a power loss.

The problem is cost. `fsync` is one of the most expensive system calls you can make. It stalls the calling thread until the storage device confirms the write, which can take anywhere from tens of microseconds on a fast NVMe drive to tens of milliseconds on a spinning disk or network-attached volume. Percona published [a thorough benchmark](https://www.percona.com/blog/fsync-performance-storage-devices/) showing just how dramatic the differences are across devices.

For a storage engine that writes many small records per second, calling `fsync` after every write would destroy throughput. But skipping it means data loss on crash. This tension — durability versus write throughput — is one of the two problems that shape how we manage file descriptors in ReductStore.

## Close means upload on FUSE-mounted storage

The second problem is less common but equally painful if you hit it. ReductStore can run on top of S3-compatible object storage mounted as a local filesystem via a FUSE driver (for example, `s3fs`, `goofys`, or `mountpoint-s3`).

FUSE drivers emulate POSIX file semantics on top of an object store. They let you `open`, `write`, and `read` as if you were working with a local file. The important difference is how they handle `close()`: when you close a file descriptor that was opened for writing, the FUSE driver uploads the entire file to the remote object store. This is the only moment it can guarantee the object is consistent — partial writes to an S3 object are not possible, so the driver must send the complete file as a single PUT.

For a storage engine, this creates a serious problem. If we follow the naive lifecycle — open a block file, write records into it, close it when full — every close triggers a full upload of the block. That might be acceptable for large sealed blocks. But if we also close the file between writes (for example, to limit the number of open file descriptors), every close sends the partially-filled block to S3, potentially megabytes of data, only to download and re-upload it on the next write.

The cost scales with block size and write frequency. For a 64 MB block that receives a few hundred records per second, closing and reopening the file after each write would mean uploading 64 MB hundreds of times — clearly unacceptable.

This means file descriptor lifetime directly affects both network cost and write latency when running on FUSE-mounted storage. We cannot treat `close()` as a cheap cleanup operation.

Both problems point in the same direction: for a storage engine, `close()` is not free. It carries durability semantics on local filesystems and upload semantics on remote ones. The way we open, hold, and eventually close file descriptors must account for both — without leaking descriptors or starving the system of resources.

## Caching File Descriptors

The first issue to address is descriptor lifetime. Instead of closing a block file after each operation, we want to keep its descriptor open and reuse it across reads and writes.
However, keeping every block file open indefinitely is not practical:

1. The operating system limits the number of open file descriptors per process. On many Linux systems the default is 1024. The limit is tunable, but it is never infinite, and a storage engine managing thousands of blocks can easily exceed it.
2. Some filesystem operations require the file descriptor to be closed first. You cannot delete or rename an open file on every platform.
3. Descriptors must be accessible from different parts of the program — writers, readers, compaction — so they need a shared data structure regardless.

Since we already need a shared structure, we can make it a cache with two eviction rules:

- **Capacity limit:** when the number of open descriptors exceeds a configured maximum, evict the least-recently-used entry.
- **Idle timeout:** evict any descriptor that has not been accessed within a configurable period.

Every access refreshes the entry's timestamp, so actively-used files stay open while idle ones are closed automatically. When the cache evicts an entry, it returns it to the caller — the caller is responsible for closing the file descriptor and handling any side effects (the fsync or the FUSE upload).

You can see the full implementation in [`reductstore/src/core/cache.rs`](https://github.com/reductstore/reductstore/blob/main/reductstore/src/core/cache.rs).

This design addresses the FUSE problem directly: as long as a block is receiving writes, its descriptor stays in the cache and `close()` is never called. No redundant uploads happen. Idle blocks eventually get evicted and uploaded once, which is acceptable because they are no longer being written to.

However, the cache alone does not solve durability. It controls *when* we close, but it says nothing about *when* we sync. We still need a mechanism that calls `fsync` at the right moments without stalling every write. That is the subject of the next section.


## Async Filesystem Synchronization

The descriptor cache from the previous section determines *when* we close files, but it says nothing about *when* we sync them. Calling `fsync` on every write is not an option — ReductStore's append-heavy workload would stall on every record. Instead, synchronization is split into two paths:

- **Sealing** — when a block reaches capacity, the engine truncates it to its final size, runs compaction, calls `fsync`, and only then removes the WAL entries. This is a synchronous durability boundary.
- **Periodic sync** — for blocks still receiving writes, a background task calls `fsync` on every dirty descriptor at a fixed interval (100 ms by default).

The rest of this section focuses on the second path — the async periodic sync — because it is the one that requires additional machinery.

### Trade-off

Between two sync cycles, data lives only in the kernel page cache. A crash during that window can lose up to 100 ms of writes. In practice this is acceptable: outages caused by power loss or OOM kills are rare, and the resulting data gap (sub-second) is negligible compared to the minutes or hours the system is typically offline.

### Tracking dirty descriptors

To know which descriptors need syncing, we wrap each real file descriptor in a proxy struct. The proxy implements the standard filesystem traits (`Read`, `Write`, `Seek`) so callers interact with it as if it were a normal file, but internally it records the open mode and the timestamp of the last write. The sync task uses this timestamp to decide whether a descriptor is dirty.

### The file cache

The proxy, the LRU cache from the previous section, and the sync worker come together in a single structure — the file cache:

```svgbob
                           +--------------------+
                           | File Cache         |     +-----------+
"Rest of application" <--->+ * exclusive access +-----+ Sync task |
                           | * synchronization  |     +-----------+
                           +---------+----------+
                                     ^
                                     |
                               +-----+------+
                               | Cache      |
                               | * eviction |
                               +-----+------+
                                     ^
                                     |
                          +----------+----------+
+------------------+      | "File-Proxy"        |
|  File Descriptor +----->+ * hold descriptor   |
+------------------+      | * track dirty state |
                          +---------------------+
```

The file cache provides an API for the rest of the application to open and write files. Internally it manages locking (so two tasks cannot write to the same descriptor concurrently) and delegates eviction and sync to their respective subsystems.

In ReductStore's code, a write looks like this:

```rust
let mut lock = FILE_CACHE
    .write_or_create(
        &ctx.file_path,
        SeekFrom::Start(
            ctx.offset + written_bytes - chunk.len() as u64,
        ),
    )
    .await?;

lock.write_all(chunk.as_ref())?;
```

Every call specifies the seek offset explicitly. Because the descriptor is shared across readers, writers, and compaction, no caller can assume it is positioned at the end of the file.

You can find the full implementation in [`reductstore/src/core/file_cache.rs`](https://github.com/reductstore/reductstore/blob/main/reductstore/src/core/file_cache.rs).

:::notice
This design uses a process-global singleton (`FILE_CACHE`). In hindsight, this was a mistake. Unit tests became coupled through the shared cache, leading to flaky failures and hidden dependencies. A better approach would be to inject the file cache as an explicit dependency so each test can use its own isolated instance.
:::

## Conclusion

File descriptors are more than disposable handles in a storage engine. Closing one can trigger an expensive remote upload, while syncing one can stall the write path. Treating descriptor lifetime and durability as separate concerns lets ReductStore control both costs: an LRU cache keeps active files open without exhausting system limits, periodic synchronization bounds data loss for active blocks, and sealing provides a synchronous durability boundary.
