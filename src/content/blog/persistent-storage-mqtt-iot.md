---
title: 'Persistent Edge Storage for a Legacy IIoT System'
description: 'How we integrated ReductStore into an existing MQTT-based IoT pipeline to solve connectivity gaps and selective data replication—without changing the customer''s architecture.'
tags:
 - iot
 - mqtt
 - customer-story
pubDate: '2026-05-29'
---

 In real-life projects, nothing is perfect. But usually we don't touch systems that already work.
 Especially when a customer has already invested almost a million euros into that system.                                                                     
                                                                                                                                                              
 When you come with your solution, you don't have full freedom to change everything as you wish. You cannot just say: "Let's replace this part", "Let's       
 change the architecture", or "Let's use a better protocol". Maybe technically it would be better, but in reality the system is already there, people use     
 it, and the customer paid a lot of money for it.                                                                                                             
                                                                                                                                                              
 So you have to adjust your solution to the existing system. You have to be flexible, understand the constraints, and adapt to the customer's needs.          
                                                                                                                                                              
 This is a real story about how we enabled long-term persistent storage with [ReductStore](https://www.reduct.store) for a customer with a legacy IIoT system. 

## No persistent storage, no access to raw data

The customer had a pretty typical IoT setup:

- Fleet of IoT devices which collect data from vibration sensors, do analysis on the edge, and send the results to the cloud via MQTT
- Cloud backend based on GCP: Hono for authentication and data ingestion from MQTT to Pub/Sub, Cloud Run for processing, BigQuery for storage and analysis
- Grafana for visualization and alerting


```svgbob
+----------------------------------------------------------------------------+
| Google Cloud                                                               |  
|                                                   BQ Tabels                | 
|                                                                            | 
|    +--------------+                          +--+--+--+--+--+--+--+        |
|    |   Grafana    | <----------------------- |  |  |  |  |  |  |  |        |
|    +--------------+                          +--+--+--+--+--+--+--+        |
|                                              |  |  |  |  |  |  |  |        |
|                                              +--+--+--+--+--+--+--+        |
|                                              |  |  |  |  |  |  |  |        |
|                                              +--+--+--+--+--+--+--+        |
|                                                          ^                 |
|                                                          |                 |
|                                         +------------------------------+   |
|                                         |"Cloud Function (Processing)" |   |
|                                         +------------------------------+   |
|                                                          ^                 |
|                                                          |                 |
|                                            +------------------------+      |
|                                            |"Hono (MQTT → Pub/Sub)" |      |
|                                            +------------------------+      |
|                                                          ^                 |
+----------------------------------------------------------|-----------------+    
                                                           |
+----------------------------------------------------------|-----------------+
|  Edge Device                                             |                 | 
|  +----------------+    +-------------------+    +----------------+         |
|  | Vibration Data | -> | Analytics on Edge | -> |  MQTT Brdige   |         |
|  +----------------+    +-------------------+    +----------------+         |
|                                                                            |
+----------------------------------------------------------------------------+
```
The system worked pretty well. But the customer wanted to store raw vibration data for training and validation of AI models. They didn't need all of it—only data collected when production was running at stable speed. That's what was useful for their models.

The current setup was designed for structured data and didn't have a data flow for raw data. On top of that, many devices had connectivity issues and couldn't store data persistently—so the data was lost when the connection went down. The IoT team had to copy data manually from devices after outages, which was a huge pain and still caused data loss.

This would be a perfect use case for ReductStore, if we had a chance to replace the existing MQTT → Hono → Pub/Sub flow with ReductStore directly. But the customer didn't want to change the architecture or have an additional service available publicly. They wanted us to integrate ReductStore into the existing system, so that raw data is stored in ReductStore on the edge, replicated to a cloud ReductStore instance, and also sent to Pub/Sub for processing and BigQuery storage.

So what we had to do:

1. Store all raw data persistently on edge with ReductStore
2. Replicate data from edge to a cloud ReductStore instance
3. Re-send all data to the existing cloud backend after connectivity outages
4. Store vibration data in the cloud only for certain conditions—when production is running at stable speed

## Reliable delivery to the cloud

Storing all MQTT data locally in ReductStore wasn't a problem. 
We wrote a simple Python service that subscribes to MQTT and stores all messages in ReductStore with necessary labels. 
The system was based on MQTT v5 and used user properties to pass metadata, so we just extracted them and used them as labels in ReductStore.

The real challenge was how to re-send data to the cloud after connectivity issues.

The data lands in BigQuery, and BigQuery doesn't protect against duplicates, so we had to make sure we don't send the same data twice.
If we could use ReductStore's replication directly, it wouldn't be an issue at all—we could create a replication task with a filter for the relevant labels, and it would take care of everything. 
But we had to send data via MQTT, so we had to be more creative. We explored two options:

### Continuous Queries

ReductStore has an option to query data continuously with a filter. 
You specify a beginning timestamp, and it returns all data matching the filter that arrives after that timestamp. 
We could use this to re-send data to the cloud after connectivity issues.

However, if a device is restarted, it loses the timestamp of the last sent message, and we would have to re-send all data from the beginning. 
That's not acceptable.

We could store the timestamp in a file, but that's a bit hacky and not very reliable.

Another option would be to update labels of sent messages with a "sent" flag and use it in the filter. 
But that solution is also not ideal:

1. Updating labels on every message is not very efficient and could cause performance issues.
2. You still need to query all messages from the beginning to find the last sent one, which is also not efficient.

Looks like standard ReductStore features are not enough to solve this problem, so we had to come up with a custom solution.

### Replication to a fake target

ReductStore has replication tasks to replicate data to another instance, selecting by labels. It has a transaction log and guarantees that all data is replicated in order and without duplicates.

But we have to send data via MQTT!? Actually, it's not a problem if you know how things work. We can create a middleman service which implements the necessary HTTP endpoints for replication and sends data to the cloud via MQTT.

This is the approach we chose, and it was the right one.

## Building the HTTP-to-MQTT bridge

We already had an MQTT bridge service that sent MQTT messages from internal services to the cloud, so we just had to rework it into an HTTP service.
It needed to receive HTTP requests from ReductStore's replication task, extract the data and labels, and send them to the cloud via MQTT.

In other words, the MQTT bridge becomes the replication target—ReductStore thinks it's talking to another ReductStore instance, but behind those endpoints sits our bridge that forwards everything over MQTT.


```svgbob   
                                                                  "GCP Cloud"
                                                                      ^
+---------------------------------------------------------------------|------------+
|  Edge Device                                                        |            | 
|  +----------------+    +-------------------+               +----------------+    |
|  | Vibration Data | -> | Analytics on Edge |               |  MQTT Brdige   |    |
|  +----------------+    +-------------------+               +----------------+    |
|               \           /                                         ^            |
|                \         /                                          |            |
|                 v       v                                       HTTP API         |
|          +------------------------+        +------------------------|----------+ |     
|          |        Connector       |        | +--------+   +------------------+ | |
|          | "(MQTT -> ReducStore)" |------->| | Bucket |-->| Replication Task | | |
|          +------------------------+        | +--------+   +------------------+ | |
|                                            | ReductStore Instance              | | 
|                                            +-----------------------------------+ |
|                                                                                  |
+----------------------------------------------------------------------------------+
```

The diagram shows the data flow: vibration data enters the Connector, which writes it into a ReductStore bucket. The replication task inside ReductStore pushes batches of records to the MQTT bridge's HTTP API, and the bridge forwards them to the cloud over MQTT.

The replication task is configured on the edge ReductStore instance with a target URL pointing to the MQTT bridge's HTTP endpoint and a label filter that selects only analytics data collected during stable production speed. This way, only relevant records get replicated to the cloud—raw vibration data and irrelevant measurements stay on disk locally.

To imitate a target ReductStore instance, the service must implement the following HTTP endpoints:

- [GET /api/v1/b/:bucket_name](https://www.reduct.store/docs/1.18.x/http-api/bucket-api#get-information-about-a-bucket) - to get information about the bucket to initialize replication
- [POST /api/v1/b/:bucket_name/:entry_name/batch](https://www.reduct.store/docs/1.18.x/http-api/entry-api/write_data#write-a-batch-of-records) - to receive data from the replication task and send it to the cloud via MQTT


It is not much, but data comes in batches, so we had to parse the HTTP headers and extract data from the HTTP body before sending it to the cloud via MQTT.
The batch protocol is documented here: https://www.reduct.store/docs/next/http-api/entry-api#batch-protocol.

If the MQTT bridge is able to send data to the cloud, it returns 200 OK, and the replication task removes the records from the transaction log.
So we have a guarantee that data is sent to the cloud without duplicates and in order, and we don't have to worry about connectivity issues at all.

In case of connectivity issues, the MQTT bridge returns errors per record according to the batch protocol. If the connection drops mid-batch, successfully sent records are acknowledged and only the failed ones are retried by the replication task. This means no data is sent twice and no records are lost—even on partial failures.

Data is stored persistently on disk and keeps accumulating during outages. ReductStore uses a FIFO quota: once the disk quota is reached, the oldest records are evicted to make room for new ones. So data loss only happens if an outage lasts long enough for the quota to roll over unsent records—in practice, with a reasonable disk size and typical outage durations, this never happened.

## What we achieved

Before this project, the customer had two painful gaps: raw vibration data was never stored—it was processed on the edge and discarded immediately, so there was no way to go back and use it for model training later. And processed MQTT data was regularly lost during the frequent connectivity outages their edge devices experienced. 
The IoT team spent hours after every outage manually pulling data from devices—and still lost some of it.

With ReductStore on the edge and a thin HTTP-to-MQTT bridge, both problems are gone. 
Raw vibration data is now persisted in ReductStore on each device and can be queried directly over HTTP whenever the data science team needs it for model training or validation. 
There is no need to push gigabytes of raw sensor readings to the cloud—it stays where it's most useful and cheapest to store.

For processed data that must reach the cloud, the replication task handles everything automatically. 
Data is persisted on disk the moment it arrives, and once connectivity returns the bridge drains the backlog in order, without duplicates, without manual intervention. 
The FIFO quota ensures the disk never fills uncontrollably, and label-based filtering means only data collected under relevant production conditions is replicated—everything else stays local.

The most important part: none of this required changes to the customer's existing cloud infrastructure. 
The MQTT → Hono → Pub/Sub → BigQuery pipeline remained untouched.
The bridge simply slots in as a transparent layer between ReductStore and the existing MQTT ingestion point.
For the cloud backend, nothing changed—it still receives MQTT messages in the same format as before.
