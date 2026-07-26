---
title: "Efficient Data Logger Design"
description: 'A battle-tested data logger design for local disks and remote storage.'
draft: false
tags:
    - system-design
    - database
pubDate: '2026-06-20'
slug: 'efficient-data-logger-design'
---

This article describes the data logger design used in [ReductStore](https://www.reduct.store/), a multimodal time-series storage engine. The design is not theoretical: it is battle-tested in a real project and shaped by practical constraints around durability, write throughput, indexing, and recovery.

The main idea is to keep writes simple while still making reads efficient. The same layout should work when data is stored on a local disk, on network filesystems such as NFS, or in remote object storage such as S3. That constraint affects many design choices: metadata should be small and fetchable on its own, data blocks should become immutable, and recovery should not require scanning large objects unless absolutely necessary.


## Append-only logger

Let's start with the simplest design: an append-only log.

Every time we store a new record, we write it to the end of the file. Existing records are never modified in place, which makes writes simple and predictable.

```svgbob
+-----------------------+----------------+
| "2023-01-01 00:00:00"   some data      |
+-----------------------+----------------+
| "2023-01-01 00:01:00"   some more data |
+-----------------------+----------------+
| "2023-01-01 00:02:00"   even more data |
+-----------------------+----------------+
```
:::notice
The timestamp does not have to be stored as an ISO string. In a real system, it could be a Unix timestamp, a monotonic sequence number, or even a delta from the previous entry. We use ISO strings here only to keep the examples readable.
:::

This design has a few important advantages:
* Writes are sequential, which is usually efficient for storage. 
* Records are never overwritten, which simplifies recovery after crashes. 
* The format is easy to inspect and reason about.

However, this simplicity comes with limitations. As the log grows, reads become slower because we may need to scan large amounts of data. The file also grows indefinitely unless we introduce partitioning or retention rules.

Our journey starts with this simple design, but as we will see, we need additional structure to build a resilient and efficient data logger.

## Partitioning and pre-allocation

Append-only logs are simple, but a single ever-growing file quickly becomes inconvenient.

There are a few practical issues:

* The log grows indefinitely, which makes retention and cleanup harder.
* Large files are slower to scan when looking for a specific time range. 
* A single append position can become a bottleneck when multiple writers are writing concurrently.
* Growing a file gradually may cause allocation overhead and filesystem fragmentation.

To address these issues, we can split the log into fixed-size blocks. Instead of writing everything into one large file, the logger writes records into the current block until it is full, then creates a new one.

```svgbob
+----------------+
| Date directory |
+----+-----------+
     |   +---------------------------+
     |---| "2023-01-01-00:00:00.blk" |
     |   +---------------------------+
     |   
     |   +---------------------------+
     |---| "2023-01-02-00:00:00.blk" |
     |   +---------------------------+
     |   
     |   +---------------------------+
     |---| "2023-01-03-00:00:00.blk" |
         +---------------------------+
```

We can also pre-allocate each block. This means the logger asks the operating system to reserve a fixed amount of disk space in advance. Once the block exists, writers do not have to compete for a single append position. The logger can hand out byte ranges inside the block, and each writer can fill its assigned range independently.

```svgbob
+-------------------------------------------+
| "2023-01-01-00:00:00.blk"                 |
+-----------------------+-------------------+
| "2023-01-01 00:00:00" | some data         | <--- Writer N1
| "2023-01-01 00:01:00" | some more data    | <--- Writer N2
+-----------------------+-------------------+
```


For example, writer N1 may receive bytes `0..1023`, while writer N2 receives bytes `1024..2047`. Both writes target the same block, but they write to different positions, so they can proceed in parallel without waiting for one shared append pointer to move.

:::notice
This approach has an important constraint: the logger must know the record size at the beginning of the write operation. If data arrives as an open-ended stream, the logger first has to receive the full record and only then assign a byte range for it. That means it cannot start writing that record in parallel with other records while the stream is still being received.
:::

When the current block reaches its maximum size, the logger closes it and starts a new block.

Each block has a timestamp in its name, which makes it easier to locate data by time range. For example, if we need records from `2023-01-01 00:30:00`, we can start by opening the block that covers that time window instead of scanning the entire log.

This design improves write organization and makes reads more manageable, but it introduces a new constraint: the logger needs to know where each record is located inside the block. That means we need metadata describing record offsets, sizes, and states.


## Block Descriptor

At this point we have fixed-size blocks, and we can write records efficiently by assigning byte ranges inside a pre-allocated block. However, the block itself is still just a sequence of bytes. If we want to read a specific record later, we need to know where that record starts, how large it is, and whether it was fully written.

Without extra metadata, the reader has only two options:

* Scan the whole block and parse records one by one.
* Guess offsets based on external information, which is fragile and hard to recover after a crash.

This becomes inefficient when blocks are large. It is also unsafe for concurrent writes, because a reader may observe a record while a writer is still filling its assigned byte range.

To address these issues, we can add a block descriptor. The descriptor is a small index for one block. It stores metadata about every record written into that block:

* `time` - timestamp or logical key used to find the record.
* `offset` - where the record starts inside the block.
* `size` - how many bytes belong to the record.
* `state` - whether the record is still being written or is ready to read.

It is better to store the descriptor separately from the data block. If blocks are stored in remote storage, the reader can load only the small descriptor first, search it, and download the larger data block only when the requested record is actually present. This avoids fetching large block files just to discover that they do not contain the data we need.

```svgbob
+-----------------------------------------+
| "2023-01-01-00:00:00.blk"               |
+-----------+-----------------------------+
| some data | some more data              |
+-----------+-----------------------------+

+-----------------------------------------+
| "2023-01-01-00:00:00.meta"              |
+-----------------------------------------+
| time     | size | offset | state        |
+----------|------|--------|--------------+
| 00:00:00 | 9    | 0      | valid        |
| 00:01:00 | 14   | 14     | being written|
+-----------------------------------------+
```

Now the read path becomes much cheaper. Instead of scanning the whole block, the reader first looks at the descriptor, finds the matching entry, checks that the state is `valid`, and reads exactly `size` bytes from `offset`.

The write path also becomes more explicit:

1. The logger receives a complete record and knows its size.
2. It assigns a free byte range inside the block.
3. It creates or updates the descriptor entry with state `being written`.
4. The writer writes the record bytes into the assigned range.
5. The descriptor entry is marked as `valid` only after the write is complete.

This gives readers a simple rule: never read records that are not marked as `valid`. The data may already be present in the block, but until the descriptor state changes, it is treated as incomplete.

We could also store more information in the descriptor, such as a checksum, content type, labels, compression format, or schema version. A checksum is especially useful because it lets the reader detect a partially written or corrupted record even if the descriptor says the record is valid.

## Caching, Compaction and WAL

The descriptor gives us fast lookups, but it also creates a new write problem. Every new record changes descriptor metadata. If we rewrite the descriptor file after every record, we turn a cheap append operation into a small random update. With many writers this can become expensive very quickly.

It also weakens the append-only property of the design. The data block is still written by appending or filling assigned byte ranges, but the descriptor now needs to be updated in place. That can increase write amplification, create more filesystem work, and make remote storage less efficient because small metadata updates may require rewriting the whole metadata object.

A common solution is to keep the active descriptor in memory while the block is open. For example, the logger can keep a `BTreeMap` keyed by timestamp or record id:

```txt
timestamp -> { offset, size, state, checksum }
```

This makes descriptor updates cheap during normal writes. The logger updates memory first and writes the complete descriptor only when the block is sealed. At that point the descriptor becomes immutable, just like the block data.

However, caching alone is not safe. If the process crashes before the descriptor is flushed, the data may already be in the block, but the index that tells us where records are located is gone. On restart we would either need to scan the whole block, or lose everything written since the last descriptor flush.

To avoid that, we add a write-ahead log (WAL) for descriptor changes. The WAL is append-only, so it is cheap to write and easy to replay after a crash. Instead of rewriting the full descriptor on every record, the logger appends small metadata events to the WAL.

For this design, the most important WAL event is the commit event for a record:

```txt
record_valid { time, offset, size, checksum }
```

The data bytes are written to the block first. After the write is complete and the checksum is known, the logger appends the `record_valid` event to the WAL. Only then can the record be considered durable and visible to readers.

The write algorithm becomes:

1. The logger receives a complete record and knows its size.
2. It reserves a free byte range in the current block.
3. It adds an in-memory descriptor entry with state `being written`.
4. The writer writes the record bytes into the assigned range.
5. The logger computes or verifies the checksum.
6. The logger appends a `record_valid` event to the WAL.
7. The in-memory descriptor entry is updated to state `valid`.
8. Readers can now use this descriptor entry.
9. When the block is full, the logger writes the compacted descriptor file and removes the WAL for that block.

Compaction happens when we turn many WAL events into one final descriptor file. The WAL may contain thousands of small updates, but the sealed descriptor contains only the final clean index. After that, the block, descriptor, and data are all immutable and easy to cache or upload to remote storage.

Crash recovery is straightforward:

1. Load the last compacted descriptor, if it exists.
2. Replay the WAL events for the block.
3. Rebuild the in-memory descriptor from those events.
4. Expose only records that have a committed `record_valid` event.

If the process crashes while a writer is still receiving or writing a record, there will be no `record_valid` event for it. The bytes may exist in the block, but readers will ignore them because the descriptor never marked the record as valid.




## Conclusion

We started with a simple append-only log because it has the most important property for a durable logger: writes are predictable and existing data is not overwritten. Then we split the log into fixed-size blocks, which makes retention, parallel writes, and remote storage much easier to manage.

The block descriptor turns those blocks from plain byte containers into searchable data structures. Instead of scanning a large block to find a record, the reader can load a small metadata file, check offsets and sizes, and fetch only the bytes it needs. This becomes especially important when blocks are stored remotely, because downloading metadata is cheap while downloading every candidate block is not.

Caching the descriptor keeps the write path fast, and the WAL makes that cache recoverable. The descriptor can be updated in memory while the block is open, the WAL records durable commit events, and compaction turns many small WAL updates into one immutable descriptor when the block is sealed.

The final design keeps the good properties of append-only storage while adding the structure needed for real systems:

* Sequential or pre-allocated writes for high throughput.
* Small searchable metadata for efficient reads.
* Immutable sealed blocks for caching, replication, and remote storage.
* WAL-based recovery so committed records are not lost after a crash.
* Clear visibility rules: a record is readable only after it has a valid descriptor entry.

This is the core idea behind the [ReductStore](https://www.reduct.store/) data logger: keep the data layout simple, make metadata explicit, and use append-only recovery mechanisms to avoid turning durability into a bottleneck.

For the lower-level details of how ReductStore balances durability and performance when opening, syncing, and closing these files, see [Durable Handling of File Descriptors](/handling-file-descriptors).
