# Changelog

## 2.4.6

A reliability hotfix for the "queue grows and nothing uploads", lock-up and crash reports, and for data lost at a deploy or restart. 2.4.4 and 2.4.5 were test builds and were not published.

**Unchanged for deployed nodes, compared with 2.4.3:**
- stream registration, and the data type a new stream gets. Until a stream has stored data in the cloud, its cache is still sent first, as in 2.4.3, because the cloud types an empty stream by the first reading it stores;
- request bodies, except that a cache over 30 KB goes in chunks (2.4.3 sent it whole if it could, and deleted it at the next start);
- tags;
- timestamps;
- the node status text.

No setting changes meaning on nodes saved by 2.4.3, and no backend change is needed.

### Fixed
- **Setup is retried.** If the cloud can't be reached when the node starts (for example the network comes up after Node-RED), pool and station setup are retried with backoff (5 s up to 5 min) instead of stalling until a redeploy. The stream list is retried too. After 3 failures topics register instead, as 2.4.3 did after one, and a list that arrives later is never applied.
  - Readings buffered while pool or station setup was failing are sent once it recovers; 2.4.3 never sent them. Readings without `msg.utcSeconds` that the device clock stamped before this release are dropped instead, because they came from a wrong clock. They are counted and logged. Readings of topics 2.4.3 would still have sent (listed streams, or the stream-list-failed path) are never dropped.
  - A pool POST whose outcome is unknown (timeout, 504, reset) is re-posted only after the settle period, so a slow first creation can't leave a second pool with the same name. Errors raised before anything was sent (DNS, connect, TLS such as a not-yet-valid certificate) retry at the normal pace.
- **No duplicate streams from slow registrations.** A registration that times out may still be created by the cloud. The node now waits a settle period (default 120 s) before retrying, instead of re-posting on the next message. Registrations stay one at a time and are shared by every message for the same topic.
- **Registration and tags no longer block message handling.** Messages are acknowledged immediately. A burst for a new topic sends one registration, and stream tags go through a small limiter.
- **No boot race.** New topics register only after the stream list has loaded (or failed 3 times), so existing streams are mapped rather than re-registered. The list is mapped exactly as 2.4.3 maps it, as soon as it arrives. A topic that sent while setup was still loading is registered as soon as setup completes.
- **Topics keep the stream they are feeding.** A topic can match one stream by name (in another station, or a duplicate) and also have its own stream in this station, the one registering would return. In 2.4.3 the choice depended on start-up timing.
  - The node now keeps whichever of the two holds the newer data (the cloud's last timestamp), or its own if both were written in the last 15 minutes, or two upload intervals if that is longer (two devices feeding). Conflicts are logged.
  - Such topics wait about a minute after start-up before their first upload (up to 3 minutes if this station's stream list is slow), so the node knows every topic it sends first. Only pools whose list contains a possible conflict read this station's stream list, and only those topics wait.
  - Known limit: a variant that first sends more than a minute after start-up can't be taken into account. The node then keeps the earlier choice and logs that the variant's readings aren't uploaded, an outcome 2.4.3's start-up race could also produce.
  - The name match is kept when the two streams' data types differ, when another topic this node sends uses the other stream or would register to it (a case or space variant), or when the node writes to the stream only by its stream key (a GUID topic). That is 2.4.3's result in those cases.
  - The readings of a waiting topic are kept per upload cycle. When it is decided, its first request goes ahead of other streams. They are combined where that stores exactly what sending them in turn would (see the next section; a reading dated past year 9999, which the cloud rejects, is never combined); otherwise (a stream with no stored data yet, or with a cache) they go one cycle per request, oldest first, as 2.4.3 sent them an interval apart. Its tags are posted from its first message.
  - A topic that has a stream key never changes it while running. The 6-hourly stream-list check only reports deleted or hidden streams that are still in use.
- **Bounded uploads.** One upload loop replaces the overlapping 2-second workers.
  - As in 2.4.3, each upload cycle's readings for a stream go in one request, usually with the stream's cache in front (see the next item). A stream's requests can overlap, up to 4 at once; in 2.4.3 there was no limit. A stream with no data in the cloud yet and a cache sends one request at a time, each with the cache in front.
  - Concurrency starts at 6 requests and grows by 2 every 5 successful uploads while a backlog waits, up to 32 (2.4.3 added workers without limit). It halves on timeouts and connection errors, down to 2. Streams take turns, so none is starved.
  - When a stream has 4 cycles waiting, new cycles are combined with the last waiting one, up to 2,000 readings per request, but only where that stores exactly what sending them in turn would:
    - the stream already has stored data in the cloud (an empty stream is typed by a request's first reading);
    - no cache would go in front;
    - no cycle could be rejected (a text value in a number stream).
  - Each cycle keeps its own typing. Only a stream more than 32 full cycles behind has its oldest cycle moved to the disk cache. Memory stays bounded.
  - A failed cycle goes to the disk cache on its own; the stream's other cycles are still sent, as in 2.4.3.
  - New readings are picked up as soon as they are queued, so one slow request doesn't hold up other streams.
  - PURGE_DATA drops buffered readings and the disk cache, as in 2.4.3. Cycles already waiting for upload are still sent, as 2.4.3 had them in flight.
  - With an upload interval of 0 or less ("continuous"), readings are collected every second, as in 2.4.3.
- **A cache no longer holds up a stream's live data, and a large one is no longer deleted unsent.** As in 2.4.3, a stream's cache is sent in front of its next readings.
  - If that request fails, new readings go without the cache for a while (1 minute, doubling up to 30 minutes), and the cache is tried again. The first upload that succeeds meanwhile allows one immediate retry, so a cache built up during an outage still goes out as soon as the cloud is back. In 2.4.3 a cache too slow to send blocked the stream's uploads entirely.
  - This doesn't apply to a stream with no stored data in the cloud yet (no upload in this run whose first reading the cloud stores, and no last timestamp in the stream list). It keeps 2.4.3's cache-first behaviour, so its data type can't change.
  - A stream whose own uploads without the cache also failed was in an outage: its cache goes with the next successful upload. Otherwise, while uploads succeed, the cache is retried at least once a minute.
  - Large caches (over 64 KB) are sent at most 2 at a time to bound memory. A request that finds no free slot goes without the cache, which follows with a later request, so other streams aren't held up.
  - A cache too big for one request (2.4.3's upload overflowed at about 124,000 readings, and then deleted the cache unsent) goes in chunks; see the next item.
  - A cache is deleted only after it was read and sent, or if it holds no readable record, as in 2.4.3. A cache it couldn't read is kept.
- **No cache is deleted for its size or age.** 2.4.3 deleted every cache file over 30 KB or older than 30 days at each start, and a deploy is a start, so a deploy during an outage lost the backlog.
  - A cache that grows past 30 KB moves to `bitpool-data/replay`, which no start deletes. It goes out in chunks, oldest first: 2,000 readings at first (and at most about 1 MB of the file), halved after a failed request and doubled after a success, up to 4,000. While chunks are left the next goes at once, without waiting for new readings, and after a restart the cache resumes after the last chunk the cloud accepted. A cache within 30 KB is sent whole, as in 2.4.3.
  - Chunks store what 2.4.3's single request would have: a reading at a second the file has already sent, or that a later reading has, is left out (this is kept next to the file, so it holds across a restart). Until the stream has stored data, a chunk after the first starts with an empty record, so it can't change the stream's type.
  - Cached readings with a date the cloud rejects (outside years 0001-9999, such as a time given in milliseconds) are left out of the request and logged. In 2.4.3 one such reading got every request carrying the cache rejected, until a restart deleted the cache. A stream with no stored data keeps its registered type, as it did in 2.4.3.
  - A record cut off at the end of a cache file (a crash or a full disk) is cut away before anything is appended after it, so it can't corrupt later readings.
  - Cache files in the main folder that 2.4.3 would delete at this start (over 30 KB, or older than 30 days) are set aside in `bitpool-data/hold`: kept and reported, but sent only on the new REPLAY_HELD command, because data may have been backfilled since.
  - While free disk space is below 100 MB or 2% of the disk, whichever is smaller (Node.js 18.15 and later), a cache doesn't grow past 30 KB, so it can't fill the disk; within 30 KB it is written as in 2.4.3. Readings it can't take are kept in memory, up to 2,000 per stream, saved at close, and the problem is logged.
  - After a rollback, 2.4.3 sends and sweeps the main folder only, as before, and leaves `replay`, `hold` and `spool` alone.
- **Nothing waiting for upload is lost when the node closes** (a deploy, a restart or stopping Node-RED). 2.4.3 dropped every reading not yet uploaded.
  - Each stream's buffered readings and the upload cycles waiting are saved to `bitpool-data/spool` as the requests they would have been, and the next start sends them first, oldest first, exactly as they would have been sent. They don't go through the disk cache, whose format can't hold every value as sent ("" in a number stream comes back as 0).
  - Requests already running get 2 s to finish, and are cached if they fail, as in 2.4.3. One still running then is stopped and its cycle saved with the others (if the cloud stored it anyway, sending it again stores the same values).
  - Cycles held for the start-up check above are still sent before close finishes, for up to 5 s, as 2.4.3 had already sent them; whatever is left is saved.
  - Everything waiting is on disk within that time (normally at once, within 2 s with requests running). Then a stream registration in flight is waited for, up to 10 s, never abandoned, and its topic's readings are saved too. Readings of topics that have no stream key yet can't be saved, as in 2.4.3; they are counted and logged. Close always finishes within about 14 s (Node-RED allows 15).
  - Saved cycles go only to streams the node maps at its next start, as the cache does. For a stream with no stored data yet, they wait until a reading sent after the restart has been stored: the stream's type then comes from that reading, as in 2.4.3, which lost the saved cycles. Cycles 2.4.3 had already sent (in flight, or held for the start-up check) still go first.
  - If the spool can't be written, those readings are counted and logged; they don't go through the disk cache, whose format would change some values.
  - A node deleted from the flow saves to `spool/removed-<node id>`, which only that node takes back if it is added again (as when a disabled flow is enabled).
  - The Node-RED log says how many readings close saved ("Saved 11362 reading(s) of 5365 stream(s) waiting for upload; the next start sends them") and how many the next start sends ("Sending … saved at the last close"). The node status counts readings in memory (In) and upload requests (Out), so it can't show this.
  - Two uploader nodes on the same pool share each stream's cache safely: one never rewrites or deletes a cache the other is sending.
- **No "Node closed" errors at a deploy.** Stream tags still waiting to be posted when the node closes are dropped quietly; the next start posts them, as 2.4.3 does after any restart.
- **Cache writes can't crash Node-RED.** A disk error (full disk, read-only filesystem, missing folder) is logged, and the unsent data is kept in memory, up to 2,000 readings per stream. Previously it exited Node-RED.
- **No cache corruption from unusual values.** Values 2.4.3 couldn't encode (numbers, objects or text with NUL characters in text streams) no longer tear the cache file and corrupt later records.
- **No silently lost cache appends.** An append after the file was deleted, or straight after a cache delete, is no longer dropped.
- **Cheap debug output.** With "Show debug warnings" on, each upload logged the whole HTTP response, which could lock up Node-RED and exposed the API key. It is now a one-line summary.
- **Failures are visible.** Setup, registration, upload and cache problems are reported as node errors, at most once a minute per kind, even with debug off. They appear in the Node-RED log and the editor's debug sidebar. When raised to Catch nodes (an option), the message has no `topic`, so a Catch node wired back into an uploader doesn't create a stream.
- **Redirects and HTML pages are no longer treated as success.** A redirect to an HTML page (for example a mistyped endpoint) is a failure, and the data stays cached.
- **Invalid configuration is reported.** A key without the `Bitpool2 ` prefix, an endpoint with `https://` (one with leading or trailing slashes still works, as in 2.4.3), a digits-only pool name, a negative timeout or a missing config node now shows a red status. The node stays inert, as before. With an invalid key, endpoint, pool name or timeout it buffers readings without connecting and answers SHOW_CONFIG, SHOW_POOL and SHOW_CACHE, as 2.4.3 did. With a missing config node or a cache folder that can't be created it does nothing, as in 2.4.3.
- **Close stops all work.** Closing the node stops all timers and retries; nothing is sent after close apart from the held cycles above. CREATE_POOL keeps cycles held for the start-up check (sent to their name match).
- **Interval and timeout edge cases.** An upload interval that isn't a number now uploads every 60 s (it never uploaded before). A timeout of 0 gets a deadline just past the gateway limit instead of none.
- **Code fixes.** Removed implicit globals and fixed undefined variables in error paths.
- **`engines` now says Node >= 14.** 2.4.3 already needed Node 14 (it uses optional chaining); the field said 12.

### Added
- **REPLAY_HELD command:** sends the cache files set aside at start-up (see above) for the streams this node maps, and outputs which were restored and which stay set aside.

Per-node options. They default to on for nodes added from the palette after upgrading. Nodes saved by 2.4.3 keep the old behaviour until the option is ticked.
- **Show problems in node status:** red or yellow ring.
- **Send problems to Catch nodes:** problems are always logged, at most once a minute each; this also sends them to Catch nodes.
- **Keep unsent data in memory if the cache folder can't be created** (off by default).
- **Registration settle (secs).**

"Show debug warnings" is now labelled "Verbose debug output", and defaults to off for new nodes and in the examples. The API key editor offers to add the `Bitpool2 ` prefix. When the node is saved, it removes a scheme, leading and trailing slashes, and a trailing `/public/v2` from the endpoint.
