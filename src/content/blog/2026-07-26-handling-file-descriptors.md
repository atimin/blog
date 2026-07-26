---
title: "Managing File Descriptors for Durability and Performance"
description: 'How descriptor caching and periodic synchronization balance durability, write performance, and remote-storage costs in a database engine.'
draft: false
tags:
    - system-design
    - database
pubDate: '2026-07-26'
slug: 'handling-file-descriptors'
---

In the [previous article](/efficient-data-logger-design) we described the block-based layout behind [ReductStore's storage engine](https://www.reduct.store): append-only blocks, descriptors, and a WAL for crash recovery. In this article, we move to a lower level and examine how ReductStore manages file descriptors to balance durability, write performance, and remote-storage costs.

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

`fsync` asks the kernel to write modified file data and the required metadata to the storage device, then waits for the operation to complete. Subject to the guarantees of the filesystem and storage device, a successful `fsync` makes the file contents durable across a power loss.

The problem is cost. `fsync` can be an expensive system call because it stalls the calling thread until the storage device confirms the write. This can take from tens of microseconds on a fast NVMe drive to tens of milliseconds on a spinning disk or network-attached volume. Percona published [a detailed benchmark](https://www.percona.com/blog/fsync-performance-storage-devices/) that shows how much the results vary across devices.

For a storage engine that writes many small records per second, calling `fsync` after every write would significantly reduce throughput. But skipping it risks data loss after a host failure. This tension between durability and write throughput is one of the two problems that shape how we manage file descriptors in ReductStore.

## When close means upload

The second problem appears when ReductStore runs on S3-compatible object storage mounted as a local filesystem through a FUSE driver, such as `s3fs`, `goofys`, or `mountpoint-s3`.

FUSE drivers emulate filesystem operations on top of an object store. They let applications use familiar operations such as `open`, `write`, and `read`, but their behavior is not identical to that of a local filesystem. Many object-storage FUSE drivers finalize or upload a modified object when its write handle is flushed or closed. The exact behavior depends on the driver: it may upload the complete file, use a multipart upload, or maintain a local cache before sending data to remote storage.

For a storage engine, this can create a serious problem. Closing a sealed block may reasonably finalize one remote object. Closing an active block between writes, however, may repeatedly upload its current contents. Reopening it later may also require another download before the next update. The amount of extra work depends on the driver's caching and upload strategy.

The cost scales with block size and write frequency. With a driver that uploads complete modified files, repeatedly closing a preallocated 64 MB block could transfer that block many times before it is sealed. This is too expensive for a write-heavy workload.

This means file descriptor lifetime directly affects both network cost and write latency when running on FUSE-mounted storage. We cannot treat `close()` as a cheap cleanup operation.

These two problems are related but distinct. On a local filesystem, `close()` does not guarantee durability; the engine must synchronize data explicitly. On some FUSE-mounted object stores, closing or flushing a modified file may trigger expensive remote work. Descriptor lifetime and synchronization policy must therefore be managed together, without leaking descriptors or exhausting system resources.

## Caching file descriptors

The first issue to address is descriptor lifetime. Instead of closing a block file after each operation, we keep its descriptor open and reuse it across reads and writes. However, keeping every block file open indefinitely is not practical:

1. The operating system limits the number of open file descriptors per process. On many Linux systems the default is 1024. The limit is tunable, but it is never infinite, and a storage engine managing thousands of blocks can easily exceed it.
2. Some filesystem operations require the file descriptor to be closed first. You cannot delete or rename an open file on every platform.
3. Writers, readers, and compaction tasks all need access to descriptors, so the program needs a shared data structure for them.

Since we already need a shared structure, we can make it a cache with two eviction rules:

- **Capacity limit:** when the number of open descriptors exceeds a configured maximum, evict the least-recently-used entry.
- **Idle timeout:** mark a descriptor for eviction when it has not been accessed within a configurable period.

Every access refreshes the entry's timestamp, so actively used files remain in the cache. Expired entries are considered when the cache processes a new insertion. Before eviction, the file-cache layer tries to obtain exclusive access to the descriptor. It returns a descriptor to the cache if another task is using it; otherwise, it attempts to synchronize dirty data before allowing the handle to close.

You can see the full implementation in [`reductstore/src/core/cache.rs`](https://github.com/reductstore/reductstore/blob/main/reductstore/src/core/cache.rs).

This design reduces the FUSE problem directly: while a block is receiving regular writes, its descriptor remains cached and is not repeatedly closed. An idle block can still be evicted, reopened, and evicted again later, so caching reduces redundant uploads rather than eliminating them completely.

The cache controls *when* descriptors close, but it does not decide *when* data becomes durable. That requires a separate synchronization policy.

## Asynchronous filesystem synchronization

Calling `fsync` after every write would make ReductStore's append-heavy workload wait on every record. Instead, the engine uses three synchronization paths:

- **Block finalization:** when a block reaches capacity, the engine truncates its data file, saves the final descriptor and index metadata, and schedules the related files for synchronization. This work continues in the background, so finalizing a block is not a strict synchronous durability boundary.
- **Periodic synchronization:** a background worker checks the cache every 100 ms. It selects up to 16 eligible dirty files, starting with those that have waited longest, and synchronizes files that are not currently in use.
- **Explicit synchronization:** operations such as a graceful shutdown first save cached metadata and then force all writable files in the cache through the synchronization path. This is the path to use when the caller must wait for storage work to finish.

The rest of this section focuses on periodic synchronization because it requires dirty-state tracking, batching, and coordination with active readers and writers.

### Trade-off

Writes made since the last successful synchronization may exist only in the kernel page cache. A power loss or hardware failure can therefore lose the most recent writes, typically around 100 ms of data with the default worker schedule. This is an approximate window rather than a strict limit because a busy descriptor, slow storage, or a failed synchronization can extend it.

For continuous data logging systems, this is often a practical trade-off. A power cycle or hardware outage can leave the system unavailable for several minutes or even hours. Compared with an interruption of that length, a gap of roughly 100 ms is small, while avoiding an `fsync` after every record substantially improves write throughput.

### Tracking dirty descriptors

To know which files need synchronization, ReductStore wraps each file handle in a small type that implements the standard `Read`, `Write`, and `Seek` traits. The wrapper stores the access mode, a dirty flag, and the time of the last successful synchronization. A write or resize operation marks the file dirty; a successful synchronization marks it clean and updates the timestamp.

The scheduled worker uses non-blocking lock attempts, so it skips a descriptor that is already in use instead of waiting for it. After the worker obtains the descriptor's write lock, however, a new reader or writer must wait until the local `fsync` and any backend upload complete. Moving synchronization to a worker avoids an `fsync` on every record, but it does not make the underlying storage operation non-blocking.

### The file cache

The wrapper, the LRU cache from the previous section, and the synchronization worker come together in a single structure: the file cache.

```svgbob
                           +--------------------+
                           | File cache         |     +-----------+
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
                          +----------+-----------+
+------------------+      | File wrapper         |
| File descriptor  +----->+ * holds descriptor   |
+------------------+      | * tracks dirty state |
                          +----------------------+
```

The file cache provides an API for the rest of the application to open and write files. Internally, it allows only one task at a time to seek, read, or write through a shared descriptor, while the cache and worker handle eviction and synchronization.

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

Every call specifies the seek offset explicitly. Because readers, writers, and compaction tasks share the descriptor, no caller can assume that it is positioned at the end of the file.

You can find the full implementation in [`reductstore/src/core/file_cache.rs`](https://github.com/reductstore/reductstore/blob/main/reductstore/src/core/file_cache.rs).

:::notice
This design uses a process-global singleton (`FILE_CACHE`). In hindsight, this was a mistake. Unit tests became coupled through the shared cache, leading to flaky failures and hidden dependencies. A better approach would be to inject the file cache as an explicit dependency so each test can use its own isolated instance.
:::

## Conclusion

File descriptors are more than disposable handles in a storage engine. Closing one may trigger expensive remote work, while synchronizing one can delay access to the file. Treating descriptor lifetime and durability as separate concerns lets ReductStore control both costs: an LRU cache keeps active files open within a fixed limit, and a background worker synchronizes dirty files without adding an `fsync` to every record write.

