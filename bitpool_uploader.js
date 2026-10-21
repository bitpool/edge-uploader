/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

// 2.4.6 hotfix. Behaviour that decides what is stored in the cloud (request bodies, stream registration,
// data types, tags, timestamps) is unchanged from 2.4.3.
// What changed is how the node gets there: setup is retried, uploads run in one bounded loop,
// registration and tags no longer block the input path, failures are logged, cache I/O can't crash,
// readings waiting at close are saved for the next start, and no cache is deleted for its size or age.

// Timing knobs. Exported (module.exports.TIMING) so tests can shorten them.
const TIMING = {
    initDelayMs: 1,                       // 2.4.3 starts pool setup on a 1 ms timer
    retryMinMs: 5000,                     // init retry backoff: 5 s -> 5 min, +/-20% jitter
    retryMaxMs: 300000,
    retryJitter: 0.2,
    getFailuresBeforeRegistering: 3,      // after 3 failed stream-list GETs, register as 2.4.3 would
    refreshMs: 6 * 3600 * 1000,           // read-only stream-list check (reports deleted or hidden keys in use)
    s2LiveWindowMs: 15 * 60 * 1000,       // rule S2: written within max(2 intervals, this) counts as "being written"
    s2HoldMs: 60000,                      // rule S2: topics with two candidate streams wait this long after mapping
    s2MaxWaitMs: 180000,                  // rule S2: ... and at most this long for this station's stream list
    schedulerTickMs: 1000,
    uiTickMs: 1000,
    continuousIntervalMs: 1000,           // uploadInterval <= 0 means "continuous": every 1 s, as 2.4.3's enqueue timer
    regSettleMinMs: 120000,               // wait after a registration with an unknown outcome
    regSettleMaxMs: 300000,
    regPermanentBackoffMaxMs: 300000,
    healthLogRepeatMs: 60000,
    concurrencyStart: 6,
    concurrencyMax: 32,
    concurrencyMin: 2,
    tagConcurrency: 4,
    perKeyConcurrency: 4,                 // a stream's upload cycles can overlap (as in 2.4.3), up to this many
    maxQueuedBlocksPerKey: 4,             // beyond this, a stream's waiting blocks are merged (bounded backlog)
    maxBlockRecords: 2000,                // ... up to 2.4.3's largest block (its buffer cap)
    maxQueuedBlocksHardPerKey: 32,        // beyond this many full blocks, the oldest goes to the cache
    replaySlotBytes: 64 * 1024,           // caches bigger than this are sent at most maxConcurrentReplays at a time
    maxConcurrentReplays: 2,
    replayBackoffMinMs: 60000,            // after a request carrying the cache fails, send without it for a while
    replayBackoffMaxMs: 30 * 60 * 1000,
    replayChunkStart: 2000,               // a cache past 30 KB goes in chunks of this many records,
    replayChunkMin: 250,                  // ... halved after a timeout (down to this),
    replayChunkMax: 4000,                 // ... doubled after a success (up to this)
    replayChunkMaxBytes: 1024 * 1024,     // ... and of at most about this much of the file
    closeUploadWaitMs: 2000,              // at close: requests in flight get this long before they are aborted,
    closeHeldWaitMs: 5000,                // ... cycles held for rule S2 this long to be sent,
    closeRegistrationWaitMaxMs: 10000,    // ... a registration in flight up to this (it is never aborted),
    closeWriteMaxMs: 3000,                // ... and saving what is left this long
    hardDeadlineGraceMs: 5000,
};

// Readings stamped by the device clock before this date are treated as a wrong clock (see dropWrongClockReadings).
const BUILD_DATE_MS = Date.UTC(2026, 9, 15);
const MAX_TIMER_MS = 2147483647;
const MAX_SERVER_DATE_MS = Date.UTC(10000, 0, 1);   // the cloud's dates end with year 9999

module.exports = function (RED) {
    const axios = require('axios');
    const { Pool, FileStorageCache, Spool } = require("./uploader")
    const os = require("os");
    const camelCase = require('camelcase');
    const { Agent } = require('https');
    const { performance } = require('perf_hooks');

    const HTTP_TIMEOUT_SECS = 10;                   // Default HTTP session timeout in seconds
    const DATA_UPLOAD_INTERVAL_SECS = 60;           // Interval in seconds to check for data upload (default, configurable by user)
    const DATA_STORAGE_PATH = './bitpool-data';
    const AbortCtl = typeof AbortController === 'function' ? AbortController : null;
    // Stream cache locks, shared by every uploader node here: nodes on the same pool use the same cache files
    const cacheLocks = new Map();             // streamKey -> waiters for its cache lock (see uploadBlock)

    function BITPOOL(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // ---------------------------------------------------------------------------------------------------------
        // Configuration
        // ---------------------------------------------------------------------------------------------------------
        const apiKeyConfig = RED.nodes.getNode(config.apiKey);
        const poolSettings = RED.nodes.getNode(config.pool_settings);
        const isPublic = (poolSettings && poolSettings.public) || false;
        const isVirtual = (poolSettings && poolSettings.virtual) || false;

        const api_key = cleanUserInput(apiKeyConfig && apiKeyConfig.api_key) || "";
        const pool_name = cleanUserInput(poolSettings && poolSettings.pool_name) || "";
        const api_endpoint = cleanUserInput(apiKeyConfig && apiKeyConfig.api_endpoint) || "api.bitpool.com";

        // Same expressions as 2.4.3, then interpreted safely
        const configuredTimeout = Number(config.timeout || HTTP_TIMEOUT_SECS);
        const configuredInterval = Number(config.uploadInterval || DATA_UPLOAD_INTERVAL_SECS);
        const bpChkShowDebugWarnings = config.bpChkShowDebugWarnings;

        // New per-node options. A missing property (every node saved by 2.4.3) means "behave as 2.4.3".
        const healthStatus = config.healthStatus === true;
        const raiseFailuresToCatch = config.raiseFailuresToCatch === true;
        const memoryOnlyCache = config.memoryOnlyCache === true;
        const regSettleMinMs = Number(config.regSettleSecs) > 0 ? Number(config.regSettleSecs) * 1000 : TIMING.regSettleMinMs;

        // Timeout: a positive value is used as configured, on every host. 0 or NaN had no deadline in 2.4.3;
        // here they get one just past the gateway's cut. Negative values crashed 2.4.3; they are invalid config.
        const timeoutMs = configuredTimeout > 0 ? configuredTimeout * 1000 : 0;

        // Interval: values >= 1 s are kept; 0 or negative means continuous; NaN (never uploaded in 2.4.3) means 60 s.
        let intervalMs;
        if (Number.isNaN(configuredInterval)) {
            intervalMs = DATA_UPLOAD_INTERVAL_SECS * 1000;
        } else if (configuredInterval <= 0) {
            intervalMs = TIMING.continuousIntervalMs;
        } else {
            intervalMs = Math.max(1, configuredInterval) * 1000;
        }

        this.rootUrlv2 = `https://${api_endpoint}/public/v2/`;
        this.rootUrlv3 = `https://${api_endpoint}/public/v3/`;
        this.PoolTags = config.PoolTags;
        this.pool = new Pool();
        this.initComplete = true;

        // ---------------------------------------------------------------------------------------------------------
        // Runtime state
        // ---------------------------------------------------------------------------------------------------------
        let closed = false;
        let generation = 0;                       // bumped by CREATE_POOL; stale async results are ignored
        const timers = new Set();
        const counters = { unknownGuidTopics: 0, deviceReadingsDropped: 0, memoryEvictions: 0, cacheWriteFailures: 0, mappingConflicts: 0, backlogMerges: 0, backlogSpills: 0, savedAtClose: 0, notSavedAtClose: 0, restoredFromSpool: 0, quarantined: 0 };

        const init = freshInitState();
        const health = { consecutiveUploadFailures: 0, lastUploadOkAt: 0, lastUploadError: null, lastLogAt: {} };

        const queue = new Map();                 // streamKey -> [blocks] waiting to be uploaded (FIFO per key)
        const memoryPending = new Map();         // streamKey -> records kept in memory when the cache can't be written
        const seenTopics = new Set();            // topics this node has received (and streams written by key)
        const sentByName = new Set();            // msg.topic values received (rule S2 moves only these)
        // perKey: requests in flight per stream key. sequential: stream key -> backlog cycles still to send (released
        // after the rule S2 hold, or saved at the last close), which go one at a time (see queueBacklog).
        const sched = { lastEnqueueAt: now(), draining: null, wake: null, perKey: new Map(), sequential: new Map() };
        let lastUiCheckAt = now();               // 2.4.3's separate status-timer epoch
        const limiter = { cap: TIMING.concurrencyStart, successesSinceChange: 0 };
        const uploadedKeys = new Set();          // streams with a successful upload in this run (see needsCacheFirst)
        const releasedBlocks = new WeakSet();    // cycles released after the rule S2 hold (see close)
        const releasedInFlight = new Map();      // streamKey -> released cycles in flight
        let flushing = false;                    // at close: cycles held for rule S2 are still sent (flushKeys only)
        let flushKeys = new Set();
        const tagLimiter = { active: 0, waiting: [] };
        const heldLocks = new Map();             // streamKey -> cache locks this node holds
        const parked = new Map();                // streamKey -> requests in flight that wait for a cache lock or replay slot
        const replay = { active: 0, waiters: [], backoff: new Map(), chunks: new Map(), waitingForSlot: new Set() };   // cache replays (see mayReplay)
        const reg = { queue: [], queued: new Set(), deferred: new Set(), inFlightTopic: null, running: false, state: new Map() };
        const dataRequests = new Map();          // abort -> request, for the uploads in flight (see close)
        const closeAborts = { others: false, all: false };   // which uploads close has stopped (see abortUploads)
        let launches = 0;
        const abortedAtClose = [];               // { key, seq, block } of requests aborted at close
        const spoolTakes = new Set();            // saved cycles being read back (see takeSpool)
        let spoolReady = Promise.resolve();
        let spoolTaking = true;                  // false once close has gathered what it saves
        let closeSaved = false;                  // close has saved what was waiting
        let saving = false;                      // close is saving what it gathered
        let closeRemoved = false;
        const deferredSpool = new Map();         // streamKey -> saved cycles waiting for the stream's first stored data
        const deferredLive = new Map();          // streamKey -> readings sent meanwhile (see noteDeferred)
        const savedStreams = new Set();          // streams with readings saved at close (for the log line)
        const restored = { readings: 0, streams: 0, timer: null };   // taken back from the spool (see noteRestored)

        // ---------------------------------------------------------------------------------------------------------
        // Start-up checks, in 2.4.3's order. Missing config nodes and an uncreatable cache folder made 2.4.3's
        // constructor throw: the node did nothing at all. An invalid key or pool name left it answering commands
        // but never connecting. Both now show a red status; neither revives (no HTTP).
        // ---------------------------------------------------------------------------------------------------------
        if (!apiKeyConfig || !poolSettings) {
            return deadNode("invalid configuration: select an API key and pool settings");
        }
        // Cycles waiting at close are saved here for the next start (none when the cache is memory-only)
        let spool = null;
        try {
            this.fileCache = new FileStorageCache(DATA_STORAGE_PATH);
            spool = new Spool(DATA_STORAGE_PATH);
        } catch (error) {
            if (!memoryOnlyCache) {
                return deadNode(`cache folder not writable: ${DATA_STORAGE_PATH}`);
            }
            this.fileCache = memoryOnlyFileCache();
            healthLog('cache', `Cache folder not writable (${error.code || error.message}); running memory-only as configured`);
        }
        const setAside = this.fileCache.setAside || [];
        if (setAside.length > 0) {
            const kb = Math.round(setAside.reduce((n, f) => n + f.bytes, 0) / 1024);
            healthLog('set-aside', `${setAside.length} upload cache file(s) (${kb} KB) were set aside in ${DATA_STORAGE_PATH}/hold: earlier versions deleted cache files over 30 KB or 30 days old at start-up. They are kept but not sent; send the REPLAY_HELD command to send them`, true);
        }

        let inertReason = null;
        if (!isValidApiKey(api_key) || !isValidEndpoint(api_endpoint)) {
            inertReason = "invalid endpoint/key format: open and save";
        } else if (!isValidPoolName(pool_name)) {
            inertReason = "invalid pool name: open and save";
        } else if (configuredTimeout < 0) {
            inertReason = "invalid timeout: open and save";
        }

        const axiosInstance = axios.create({
            timeout: timeoutMs,
            headers: {
                "Authorization": api_key,
                "Content-Type": "application/json"
            },
            httpsAgent: new Agent({ keepAlive: false })
        });

        // ---------------------------------------------------------------------------------------------------------
        // Start-up
        // ---------------------------------------------------------------------------------------------------------
        if (inertReason) {
            node.status({ fill: "red", shape: "ring", text: inertReason });
            healthLog('inert', `Uploader is not connecting: ${inertReason}`, true);
        } else {
            if (spool) {
                // Cycles a crash left half-taken go back, and if this node was removed and is back (a disabled flow
                // enabled again), it takes its saved cycles back
                spoolReady = spool.recover(`removed-${node.id}`).catch(error => logError("Error loading saved readings:", error));
            }
            sendStartupConfig();
            startInit();
            startScheduler();
            startUiTimer();
        }

        // ---------------------------------------------------------------------------------------------------------
        // Input
        // ---------------------------------------------------------------------------------------------------------
        node.on('input', async function (msg, send, done) {
            try {
                if (msg.BPCommand == "REBUILD") {
                    logInfo("The REBUILD command is no longer supported (use CREATE_CONFIG). Note, CREATE_CONFIG will delete all exsiting configuration data.")

                } else if (msg.BPCommand == "SHOW_CONFIG") {    // ----------------------------------------------
                    send({ "payload": { "config": configPayload() } });

                } else if (msg.BPCommand == "SHOW_POOL") {      // ----------------------------------------------
                    send({ "payload": { "pool": node.pool } });

                } else if (msg.BPCommand == "SHOW_CACHE") {      // ----------------------------------------------
                    const storedKeys = node.fileCache.listStoredKeys();
                    if (storedKeys && storedKeys.size > 0) {
                        let foundAnEntry = false
                        for (const [key] of storedKeys) {
                            try {
                                if (node.fileCache.streamKeyExists(key)) {
                                    const dataType = node.pool.getStreamByNameOrKey(key).getDataType();
                                    if (dataType) {
                                        // A cache past 30 KB can be very large: at most this many records are shown
                                        await lockCache(key);
                                        let chunk;
                                        try {
                                            chunk = await node.fileCache.readChunk(key, node.fileCache.isChunked(key) ? 100000 : Infinity);
                                        } finally {
                                            unlockCache(key);
                                        }
                                        const payload = { "key": key, "data": chunk.records };
                                        if (chunk.readOk && !chunk.done) payload.truncated = true;
                                        node.send({ "payload": payload });
                                        foundAnEntry = true
                                    }
                                }
                            } catch (error) { }
                        }
                        if (!foundAnEntry) {
                            logInfo(`Did not find cached data for this pool.`);
                        }
                    } else {
                        logInfo(`There are no stored cached records.`);
                    }

                } else if (msg.BPCommand == "CREATE_POOL") {    // ----------------------------------------------
                    releaseHeldBlocks();            // cycles held for rule S2 go where 2.4.3 would have sent them
                    node.pool = new Pool();
                    if (!inertReason) {
                        restartInit();
                    }
                    logInfo(`Built a new pool.`);

                } else if (msg.BPCommand == "SAVE_POOL") {      // ----------------------------------------------
                    logInfo("The command SAVE_POOL is no longer supported in this version.")

                } else if (msg.BPCommand == "PURGE_DATA") {     // ----------------------------------------------
                    node.pool.purgeRecordsOnly();
                    node.fileCache.purge();
                    memoryPending.clear();
                    replay.chunks.clear();
                    deferredSpool.clear();
                    deferredLive.clear();
                    // Cycles already waiting for upload are still sent, as 2.4.3 had them in flight
                    releaseHeldBlocks();
                    logInfo(`Purged all record data stored on this pool (${node.pool.getPoolName()}) node.`);

                } else if (msg.BPCommand == "REPLAY_HELD") {    // ----------------------------------------------
                    send({ "payload": { "replayHeld": await replayHeld() } });

                } else if (msg.BPCommand == "UPLOAD_DATA") {    // ----------------------------------------------
                    if (!inertReason) {
                        enqueueAll();
                        await runDrain();
                    }
                    logInfo(`Uploaded all record data stored on this pool (${node.pool.getPoolName()}) node.`);

                } else if (inertReason) {
                    // As 2.4.3: a node with an invalid key or pool name buffers readings (SHOW_POOL lists them)
                    // but never connects
                    if (msg.topic && msg.topic.trim() !== "") {
                        node.pool.addStreamName(msg.topic);
                        const stream = node.pool.getStreamByNameOrKey(msg.topic);
                        if (stream) {
                            if (msg.utcSeconds !== undefined && msg.utcSeconds !== null) {
                                stream.addData(msg.payload, new Date(msg.utcSeconds * 1000));
                            } else {
                                stream.addData(msg.payload);
                            }
                        }
                    }

                } else {
                    // Data message. Nothing here waits on the network.
                    if (msg.topic && msg.topic.trim() !== "") {
                        const streamName = msg.topic;
                        node.pool.addStreamName(streamName);
                        const stream = node.pool.getStreamByNameOrKey(streamName);
                        if (!stream) {
                            // A GUID-shaped topic that isn't a known stream key: 2.4.3 dropped these too
                            counters.unknownGuidTopics++;
                            logWarn(`Topic looks like a stream key but no such stream is known, skipping: ${streamName}`);
                            return;
                        }
                        // A GUID topic writes into the stream it names: that stream counts as sent too
                        const name = stream.getStreamName() || streamName;
                        sentByName.add(streamName);
                        for (const topic of name === streamName ? [streamName] : [streamName, name]) {
                            if (!seenTopics.has(topic)) {
                                seenTopics.add(topic);
                                if (!init.s2Pending && init.s2Potential.has(topic)) {
                                    decideS2(topic, null);     // rule S2, before the topic's first upload or tag post
                                }
                                checkTopicKey(topic);
                            }
                        }

                        const utcSeconds = msg.utcSeconds !== undefined ? msg.utcSeconds : null;
                        if (utcSeconds !== null) {
                            stream.addData(msg.payload, new Date(utcSeconds * 1000));
                        } else {
                            stream.addData(msg.payload);
                        }
                        const streamKey = stream.getStreamKey();
                        const areStreamTagsPosted = stream.getTagsPosted();

                        if (!streamKey) {
                            requestRegistration(streamName);
                        }

                        // Check if tags have been posted. Do one off post if not (same occasion and body as 2.4.3)
                        if (!areStreamTagsPosted && streamKey) {
                            if (isHeld(name)) {
                                // Rule S2 may still move the topic: post to the stream it ends up with
                                if (!init.s2HeldMeta.has(name)) init.s2HeldMeta.set(name, msg.meta);
                            } else {
                                postTagsOnce(stream, msg.meta);
                            }
                        }
                    } else {
                        logWarn("Input topic is empty, skipping...");
                    }
                }
            } catch (error) {
                logError("Error on input:", error);
            } finally {
                if (done) {
                    done();
                }
            }
        });

        node.on('close', function (removed, done) {
            closed = true;
            timers.forEach(t => clearTimeout(t));
            timers.clear();
            tagLimiter.waiting.length = 0;      // not started: the next start posts each stream's tags again, as 2.4.3 does
            // done follows once everything is saved, and at the latest after the waits below (Node-RED's own limit
            // for close is 15 s)
            let capTimer = null;
            const cap = new Promise(resolve => {
                capTimer = setTimeout(resolve, Math.max(TIMING.closeHeldWaitMs, TIMING.closeRegistrationWaitMaxMs) + TIMING.closeWriteMaxMs + 1000);
            });
            const saved = Promise.race([
                closeAndSave(removed === true).catch(error => logError("Error saving readings on close:", error)),
                cap,
            ]).then(() => clearTimeout(capTimer));
            if (typeof done === 'function') saved.then(() => done());
        });

        // Close. Nothing new is sent after close, and nothing that was waiting is lost: the next start sends it.
        // - Each stream's buffered readings become one last upload cycle, as an upload tick would make them.
        // - Cycles held for rule S2 are still sent, to their name match, for up to closeHeldWaitMs: 2.4.3 had sent
        //   them already. That stops at the first failure that looks like an outage.
        // - Other requests in flight get closeUploadWaitMs to finish, and a failure is cached, as in 2.4.3. One still
        //   running then is aborted and its cycle saved with the others (if the cloud stored it anyway, sending it
        //   again stores the same values).
        // - A registration in flight is waited for (aborting one can duplicate the stream), up to
        //   closeRegistrationWaitMaxMs. If it returns, its topic's readings are saved too.
        // - Waiting cycles are saved to the spool, oldest first, as the requests they would have been; the next start
        //   sends them to the same streams. A removed node's go to spool/removed-<id>, which only that node takes back
        //   if it is added again (as when a disabled flow is enabled).
        // Readings of topics with no stream to upload to can't be saved (2.4.3 lost them too); they are counted.
        async function closeAndSave(removed) {
            const started = now();
            closeRemoved = removed;
            collectBuffers(false);
            flushKeys = releaseHeldBlocks();
            for (const [key, blocks] of queue) {
                if (blocks.some(b => releasedBlocks.has(b))) flushKeys.add(key);
            }
            for (const key of releasedInFlight.keys()) flushKeys.add(key);
            queueFirst(flushKeys);
            flushing = Array.from(flushKeys).some(key => queue.has(key));
            if (flushing && !sched.draining) runDrain(); else wakeDrain();
            await waitUntil(() => {
                const late = now() - started >= TIMING.closeUploadWaitMs;
                let heldBusy = flushing && Array.from(flushKeys).some(key => queue.has(key));
                let othersBusy = false;
                for (const key of activeKeys()) {
                    if (flushKeys.has(key)) heldBusy = true; else othersBusy = true;
                }
                if (late && othersBusy) abortUploads(false);
                return !heldBusy && !othersBusy;
            }, Math.max(TIMING.closeUploadWaitMs, TIMING.closeHeldWaitMs));
            endFlush();
            abortUploads(true);
            // What is waiting is saved first; only then is a registration in flight waited for
            await waitUntil(() => activeKeys().length === 0, TIMING.closeWriteMaxMs);
            spoolTaking = false;
            await Promise.all(Array.from(spoolTakes));
            await waitUntil(() => heldLocks.size === 0, TIMING.closeWriteMaxMs);
            collectBuffers(true);                // topics whose registration returned meanwhile
            await saveWaiting(removed);
            if (reg.inFlightTopic) {
                const left = Math.max(TIMING.closeHeldWaitMs, TIMING.closeRegistrationWaitMaxMs) - (now() - started);
                await waitUntil(() => !reg.inFlightTopic, left);
            }
            collectBuffers(true);
            if (queue.size > 0 || abortedAtClose.length > 0) await saveWaiting(removed);
            closeSaved = true;
            reportUnsaved();
            if (counters.savedAtClose > 0) {
                // Information, in the Node-RED log only: how much the next start sends (see noteRestored)
                node.log(`Saved ${counters.savedAtClose} reading(s) of ${savedStreams.size} stream(s) waiting for upload; the next start sends them`);
            }
        }

        function noteSaved(key, readings) {
            if (readings <= 0) return;
            counters.savedAtClose += readings;
            savedStreams.add(key);
        }

        // Streams with a request in flight that isn't just waiting for a cache lock or a replay slot
        function activeKeys() {
            return Array.from(sched.perKey.keys()).filter(key => sched.perKey.get(key) > (parked.get(key) || 0));
        }
        function park(key, wait) {
            parked.set(key, (parked.get(key) || 0) + 1);
            return wait.finally(() => {
                const n = parked.get(key) - 1;
                if (n > 0) parked.set(key, n); else parked.delete(key);
            });
        }

        // Stops the close flush: no more requests are started
        function endFlush() {
            flushing = false;
            wakeDrain();
        }

        // Aborts the upload requests in flight: other streams' than those of held cycles, or all. A request still
        // waiting for its cache lock or a replay slot is stopped before it sends (see stoppedByClose).
        function abortUploads(all) {
            if (all) closeAborts.all = true; else closeAborts.others = true;
            for (const [abort, request] of Array.from(dataRequests)) {
                if (!request.aborted && (all || !flushKeys.has(request.key))) {
                    request.aborted = true;
                    abort();
                }
            }
        }
        function stoppedByClose(key) {
            return closed && (closeAborts.all || (closeAborts.others && !flushKeys.has(key)));
        }
        // A request stopped at close: its cycle is saved with the waiting ones, and what was kept in memory goes back
        function keepForClose(key, seq, block, pending) {
            if (closeSaved || saving) {
                // Close has gathered what it saves already (another node held this stream's cache lock until now)
                const target = closeRemoved && spool ? spool.sub(`removed-${node.id}`) : spool;
                if (!block.sentBefore) Object.defineProperty(block, 'sentBefore', { value: true });
                const blocks = [block].filter(b => b.length > 0);
                const count = blocks.reduce((n, b) => n + b.length, 0) + (pending ? pending.length : 0);
                (target ? target.append(key, blocks).then(failed => (failed.length === 0 && pending ? target.append(key, [pending], true) : failed)) : Promise.resolve([blocks]))
                    .then(failed => {
                        if (failed && failed.length > 0) {
                            counters.notSavedAtClose += count;
                            healthLog('close-save', `${count} reading(s) waiting for upload could not be saved at close (${errorCode(target && target.lastError)})`);
                        } else {
                            counters.savedAtClose += count;
                        }
                    })
                    .catch(error => logError("Error saving readings on close:", error));
                return;
            }
            abortedAtClose.push({ key, seq, block });
            if (pending) memoryPending.set(key, pending.concat(memoryPending.get(key) || []));
        }

        // Resolves once cond() holds, or after ms
        function waitUntil(cond, ms) {
            const until = now() + Math.max(0, ms);
            return new Promise(resolve => {
                const check = () => {
                    if (cond() || now() >= until) return resolve();
                    setTimeout(check, 20);
                };
                check();
            });
        }

        // At close, each stream's buffered readings become one upload cycle, as an upload tick would make them
        function collectBuffers(ignoreHold) {
            for (const key of node.pool.getStreamKeyList()) {
                if (!key) continue;
                try {
                    const stream = node.pool.getStreamByNameOrKey(key);
                    if (!stream || stream.getRecordCount() === 0) continue;
                    const data = stream.getAllValues();
                    if (data.length === 0) continue;
                    const name = stream.getStreamName();
                    if (!ignoreHold && isHeld(name)) {
                        if (!init.s2HeldBlocks.has(name)) init.s2HeldBlocks.set(name, []);
                        init.s2HeldBlocks.get(name).push(data);
                        continue;
                    }
                    queue.set(key, (queue.get(key) || []).concat([data]));
                } catch (error) {
                    logError("Error in Enqueue Data:", error);
                }
            }
        }

        // Saves to the spool, oldest first per stream: cycles saved at the last close and not sent yet, requests
        // stopped now, then the waiting cycles
        async function saveWaiting(removed) {
            const target = removed && spool ? spool.sub(`removed-${node.id}`) : spool;
            const records = blocks => blocks.reduce((n, b) => n + b.length, 0);
            const byKey = new Map();
            const add = (key, blocks) => {
                const kept = blocks.filter(b => b.length > 0);          // [] asks for a cache chunk
                if (kept.length > 0) byKey.set(key, (byKey.get(key) || []).concat(kept));
            };
            // 2.4.3 had already sent these (in flight, or held for rule S2): see takeSpool
            const sentBefore = block => {
                if (!block.sentBefore) Object.defineProperty(block, 'sentBefore', { value: true });
                return block;
            };
            for (const [key, blocks] of deferredSpool) add(key, blocks);
            deferredSpool.clear();
            abortedAtClose.sort((a, b) => a.seq - b.seq);
            for (const { key, block } of abortedAtClose) add(key, [sentBefore(block)]);
            abortedAtClose.length = 0;
            saving = true;                       // a request stopped from now on saves its own cycle (keepForClose)
            for (const [key, blocks] of queue) add(key, blocks.map(b => (releasedBlocks.has(b) ? sentBefore(b) : b)));
            queue.clear();
            sched.sequential.clear();
            let failedWrites = 0;
            let saveError = null;
            await Promise.all(Array.from(byKey, async ([key, blocks]) => {
                // Cycles JSON can't hold (a BigInt): 2.4.3's request couldn't send them either, and cached them
                const unsendable = blocks.filter(b => Spool.line(b) === null);
                const rest = blocks.filter(b => !unsendable.includes(b));
                if (rest.length > 0) {
                    // Not into the cache if the spool can't be written: its format would change some values
                    const unsaved = target ? await target.append(key, rest) : rest;
                    if (unsaved.length > 0) {
                        failedWrites += records(unsaved);
                        saveError = (target && target.lastError) || saveError;
                    }
                    noteSaved(key, records(rest) - records(unsaved));
                }
                if (unsendable.length > 0) {
                    if (await appendLocked(key, unsendable.flat())) {
                        noteSaved(key, records(unsendable));
                    } else {
                        failedWrites += records(unsendable);
                        saveError = node.fileCache.lastError || saveError;
                    }
                }
            }));
            // Readings kept in memory because the cache couldn't be written: one more try, then saved with their cache
            // encoding, as the cache would have held them
            const held = Array.from(memoryPending);
            memoryPending.clear();
            await Promise.all(held.map(async ([key, pending]) => {
                if (await appendLocked(key, pending)) {
                    noteSaved(key, pending.length);
                    return;
                }
                const failed = target ? await target.append(key, [pending], true) : [pending];
                if (failed.length > 0) {
                    failedWrites += pending.length;
                    saveError = (target && target.lastError) || node.fileCache.lastError || saveError;
                } else {
                    noteSaved(key, pending.length);
                }
            }));
            saving = false;
            if (failedWrites > 0) {
                counters.notSavedAtClose += failedWrites;
                healthLog('close-save', `${failedWrites} reading(s) waiting for upload could not be saved at close (${errorCode(saveError)})`);
            }
        }

        // Appends to a stream's cache under its lock, waiting at most closeWriteMaxMs for it; false if it can't
        async function appendLocked(key, records) {
            let got = false;
            let late = false;
            const lock = lockCache(key).then(() => {
                if (late) unlockCache(key); else got = true;
            });
            let timer = null;
            await Promise.race([lock, new Promise(resolve => { timer = setTimeout(resolve, TIMING.closeWriteMaxMs); })]);
            clearTimeout(timer);
            if (!got) {
                late = true;
                return false;
            }
            try {
                return await node.fileCache.appendData(key, records);
            } finally {
                unlockCache(key);
            }
        }

        // Readings of topics with no stream key yet can't be saved (2.4.3 lost them too); they are counted and logged
        function reportUnsaved() {
            if (inertReason) return;
            let unsent = 0;
            let topics = 0;
            node.pool.streams.streams.forEach(stream => {
                const n = stream.getRecordCount();
                counters.notSavedAtClose += n;  // keyed ones: a topic sharing another topic's stream (never uploaded)
                if (n > 0 && !stream.getStreamKey()) {
                    unsent += n;
                    topics++;
                }
            });
            if (unsent > 0) {
                healthLog('close', `${unsent} reading(s) of ${topics} topic(s) with no stream key yet were dropped at close`);
            }
        }

        // ---------------------------------------------------------------------------------------------------------
        // Init state machine: pool -> tags (non-blocking) -> station and stream list in parallel, as in 2.4.3.
        // Every step retries with backoff. The stream list is mapped exactly as 2.4.3 maps it, as soon as it
        // arrives. Registrations start once both the list and the station are known.
        // ---------------------------------------------------------------------------------------------------------
        function freshInitState() {
            return {
                poolOk: false, stationOk: false, resolving: false,
                listDone: false,           // the list was mapped, or failed 3 times (2.4.3's GET-failed path)
                mappedAt: 0,
                getFailures: 0, attempts: { pool: 0, station: 0, get: 0 },
                poolFailedOnce: false, stationFailedOnce: false, readyHandled: false,
                lastError: null, retryAt: 0, redStatusShown: false,
                // Rule S2
                byKey: null,               // StreamKey -> listed stream
                nameMapped: new Set(),     // topics whose key came from the start-up Name mapping
                s2Potential: new Set(),    // mapped names that may also have this station's stream (held until decided)
                s2Pending: false,          // potential topics wait for this station's list and the hold period
                s2ListResolved: false,     // this station's list was read, or given up on
                local: null,               // foldNarrow(LocalIndex) -> this station's oldest stream with it
                s2Done: new Set(),         // topics rule S2 has been decided for
                s2Moved: new Set(),        // topics S2 moved to this station's stream
                s2HeldMeta: new Map(),     // topic -> msg.meta of its first message while held (tags go out once decided)
                s2HeldBlocks: new Map(),   // topic -> its upload cycles while held, one block each (typed per cycle)
            };
        }

        function sendStartupConfig() {
            if (bpChkShowDebugWarnings) {
                try {
                    // Send the pool configuration to the debug window on startup
                    node.send({ "payload": { "config": configPayload() } });
                } catch (error) {
                    logError('Failed to load configuration state.', error);
                }
            }
        }

        function startInit() {
            const gen = generation;
            schedule(() => {
                if (gen !== generation) return;
                // 2.4.3 replaces the pool when setup starts; messages in the first millisecond are discarded as before
                node.pool = new Pool();
                node.pool.setPoolName(pool_name);
                stepPool(gen).catch(error => logError("Error in pool setup:", error));
            }, TIMING.initDelayMs);
        }

        function restartInit() {
            generation++;
            Object.assign(init, freshInitState());
            reg.queue = [];
            reg.queued.clear();
            reg.deferred.clear();
            // reg.state is kept: a registration whose outcome is still unknown keeps its settle period
            sendStartupConfig();
            startInit();
        }

        function stale(gen) {
            return gen !== generation || closed;
        }

        async function stepPool(gen) {
            if (stale(gen)) return;
            const startedAt = now();
            try {
                // Add default tags and clean
                const defaultTags = [
                    `operatingSystem=${typeof os.version === 'function' ? os.version() : os.release()}`,
                    `nodejsVersion=${process.version}`,
                    `nodeRedVersion=${RED.version()}`
                ];
                const poolTagsOnNode = node.pool.cleanTags(node.PoolTags + "," + defaultTags.join(','));

                const serverPool = await postAddUpdatePool(pool_name);
                if (stale(gen)) return;
                if (!serverPool || !serverPool.PoolKey || !isValidGUID(serverPool.PoolKey)) {
                    throw protocolError(null, "The pool response did not contain a valid PoolKey");
                }
                node.pool.setPoolKey(serverPool.PoolKey);
                init.poolOk = true;
                init.attempts.pool = 0;
                if (init.poolFailedOnce) {
                    // 2.4.3 never sent anything once its pool setup had failed
                    dropWrongClockReadings(false);
                }

                postAddPoolTags(serverPool.PoolKey, poolTagsOnNode);   // non-blocking, errors are logged
                node.pool.setPoolTags(poolTagsOnNode);

                stepStation(gen).catch(error => logError("Error in station setup:", error));
                stepGet(gen).catch(error => logError("Error loading streams:", error));
            } catch (error) {
                if (stale(gen)) return;
                initFailed('pool', error, () => stepPool(gen), now() - startedAt);
            }
        }

        async function stepStation(gen) {
            if (stale(gen)) return;
            try {
                const stationID = await postAddUpdateStation(node.pool.getPoolKey(), pool_name);
                if (stale(gen)) return;
                if (stationID === undefined || stationID === null || stationID === "") {
                    throw protocolError(null, "The station response did not contain a StationID");
                }
                node.pool.setStationId(stationID);
                init.stationOk = true;
                init.attempts.station = 0;
                init.lastError = null;
                updateStatusMsg({ fill: "green", shape: "dot", text: "Pool initialised OK" });
                resolveStationList(gen).catch(error => logError("Station stream list failed:", error));
                checkReady();
            } catch (error) {
                if (stale(gen)) return;
                initFailed('station', error, () => stepStation(gen));
            }
        }

        async function stepGet(gen) {
            if (stale(gen)) return;
            try {
                const serverStreams = await getPoolStreams(node.pool.getPoolKey());
                if (stale(gen)) return;
                init.attempts.get = 0;
                applyInitialMapping(gen, serverStreams);
            } catch (error) {
                if (stale(gen)) return;
                init.getFailures++;
                if (init.getFailures >= TIMING.getFailuresBeforeRegistering) {
                    // 2.4.3's GET-failed path: nothing is mapped and topics register. 2.4.3 never read the list
                    // again, and mapping a late list could move topics that are already feeding their streams.
                    init.listDone = true;
                    logError("Error loading streams:", error);
                    healthLog('init', `The stream list failed ${init.getFailures} times (${errorCode(error)}); topics register instead, as before`);
                    checkReady();
                    schedule(() => refreshStreams(gen), jitter(TIMING.refreshMs));
                } else {
                    initFailed('get', error, () => stepGet(gen));
                }
            }
        }

        function canRegister() {
            return !!(node.pool.getPoolKey() && node.pool.getStationId() && init.listDone);
        }

        // Called whenever setup may have become complete
        function checkReady() {
            if (!canRegister() || init.readyHandled) return;
            init.readyHandled = true;
            if (init.stationFailedOnce) {
                // 2.4.3 never registered a topic once its station setup had failed. Listed topics are mapped by
                // now, so this only touches topics that are about to register.
                dropWrongClockReadings(true);
            }
            // Topics that sent while registration was on hold register now (2.4.3 would have registered them)
            const deferred = Array.from(reg.deferred);
            reg.deferred.clear();
            for (const topic of deferred) {
                const stream = node.pool.getStreamByNameOrKey(topic);
                if (stream && !stream.getStreamKey() && stream.getRecordCount() > 0) {
                    requestRegistration(topic);
                }
            }
        }

        // Readings buffered while setup was failing now go out once it recovers, where 2.4.3 never sent them.
        // Readings the device clock stamped before this package was built came from a wrong clock: drop them.
        function dropWrongClockReadings(onlyUnkeyed) {
            const dropped = node.pool.dropDeviceReadingsBefore(BUILD_DATE_MS, onlyUnkeyed);
            if (dropped > 0) {
                counters.deviceReadingsDropped += dropped;
                healthLog('clock', `Dropped ${dropped} reading(s) stamped by the device clock before ${new Date(BUILD_DATE_MS).toISOString().slice(0, 10)} while the cloud was unreachable`);
            }
        }

        function initFailed(step, error, retry, elapsedMs) {
            if (step === 'pool') init.poolFailedOnce = true;
            if (step === 'station') init.stationFailedOnce = true;
            init.attempts[step]++;
            let wait = backoff(init.attempts[step]);
            if (step === 'pool' && classifyFailure(error) === 'unknown') {
                // The request may still create the pool, and pool names aren't unique in the cloud: re-posting
                // too soon can create a second pool. Wait as registrations do.
                wait = Math.max(wait, settleMs(elapsedMs || 0));
            }
            init.lastError = errorCode(error);
            init.retryAt = now() + wait;
            const what = { pool: "pool setup", station: "station setup", get: "stream list" }[step];
            logError(`Error in ${what}:`, error);
            healthLog('init', `Bitpool cloud ${what} failed (${init.lastError}); retrying in ${Math.round(wait / 1000)}s`);
            if (step === 'pool' && !init.redStatusShown) {
                // The status 2.4.3 shows once on an init failure (the counters overwrite it on legacy nodes)
                init.redStatusShown = true;
                node.status({ fill: "red", shape: "ring", text: "Error, check valid API key and Pool Name" });
            }
            if (step === 'station' && init.attempts.station >= 3 && init.s2Pending && !init.s2ListResolved) {
                // Rule S2 can't be decided without the station: held topics keep their name match, as in 2.4.3
                init.s2ListResolved = true;
                healthLog('mapping', "Station setup is failing; topics keep their name match, as before");
            }
            schedule(retry, wait);
        }

        // The stream list is mapped exactly as 2.4.3 maps it: every listed Name gets its key, the last match wins,
        // and a row 2.4.3 could not handle stops the mapping there. No topic has a key yet (registrations wait for
        // the list), so nothing is re-keyed.
        function applyInitialMapping(gen, poolList) {
            init.listDone = true;
            init.mappedAt = now();
            let mapped = true;
            try {
                for (const serverStream of poolList) {
                    node.pool.addStreamName(serverStream.Name);
                    node.pool.updateStreamKey(serverStream.Name, serverStream.StreamKey);
                    node.pool.setDataType(serverStream.Name, serverStream.DataType);
                    init.nameMapped.add(serverStream.Name);
                }
            } catch (error) {
                mapped = false;
                logError("Error in Streams Timer:", error);
                healthLog('mapping', `The stream list has a row that can't be mapped (${errorCode(error)}); streams listed after it are not mapped, as before`);
            }

            // Rule S2: a mapped name may also have its own stream in this station (the one registering would return)
            // if a different listed stream's LocalIndex matches it. Such topics are held until S2 is decided.
            init.byKey = new Map();
            const byLocal = new Map();
            for (const s of poolList) {
                if (!s) continue;
                if (s.StreamKey) init.byKey.set(s.StreamKey, s);
                if (s.LocalIndex !== undefined && s.LocalIndex !== null) {
                    const f = foldWide(s.LocalIndex);
                    if (!byLocal.has(f)) byLocal.set(f, new Set());
                    byLocal.get(f).add(s.StreamKey);
                }
            }
            for (const name of init.nameMapped) {
                const keys = byLocal.get(foldWide(name));
                if (keys && (keys.size > 1 || !keys.has(node.pool.streams.nameToKey.get(name)))) {
                    init.s2Potential.add(name);
                }
            }
            if (init.s2Potential.size > 0) {
                init.s2Pending = true;
                resolveStationList(gen).catch(error => logError("Station stream list failed:", error));
            }

            if (mapped && bpChkShowDebugWarnings) {
                try {
                    // Send the pool object to the debug window on startup
                    node.send({ "payload": { "pool": node.pool } });
                } catch (error) {
                    logError("Error in Streams Timer:", error);
                }
            }
            checkReady();
            takeSpools(node.pool.getStreamKeyList());
            schedule(() => refreshStreams(gen), jitter(TIMING.refreshMs));
        }

        // Cycles saved at the last close go out first, as the requests they would have been. Like the cache, only to a
        // stream key this node maps (from the stream list or a registration), as 2.4.3 replays; others stay
        // saved.
        function takeSpools(keys) {
            if (!spool || !spoolTaking) return;
            const wanted = new Set(keys.filter(Boolean));
            const p = spoolReady
                .then(() => {
                    const saved = new Set(spool.keys());
                    return Promise.all(Array.from(wanted).filter(key => saved.has(key)).map(takeSpool));
                })
                .catch(error => logError("Error loading saved readings:", error))
                .finally(() => spoolTakes.delete(p));
            p.keys = wanted;
            spoolTakes.add(p);
        }
        // Readings the cache couldn't take at the last close go back in memory, in front of the stream's next upload.
        // A stream that has stored data gets its saved cycles at once; one with none yet only after its first stored
        // reading (see noteDeferred).
        async function takeSpool(key) {
            const blocks = await spool.take(key);
            if (blocks.length === 0) return;
            const readings = blocks.reduce((n, b) => n + b.length, 0);
            counters.restoredFromSpool += readings;
            noteRestored(readings);
            const cached = blocks.filter(b => b.asCache).flat();
            if (cached.length > 0) memoryPending.set(key, cached.concat(memoryPending.get(key) || []));
            const cycles = blocks.filter(b => !b.asCache);
            if (cycles.length === 0) return;
            // Cycles 2.4.3 had sent before the close (in flight, or held) typed such a stream then: they go at once
            const stored = hasStoredData(key);
            const ready = cycles.filter(b => stored || b.sentBefore);
            const later = cycles.filter(b => !stored && !b.sentBefore);
            if (ready.length > 0) {
                queueBacklog(key, ready);
                queueFirst(new Set([key]));
                wakeDrain();
            }
            if (later.length > 0) {
                deferredSpool.set(key, (deferredSpool.get(key) || []).concat(later));
            }
        }
        // Information, in the Node-RED log only: how much the last close saved and this start sends, one line for the
        // streams taken back together
        function noteRestored(readings) {
            restored.readings += readings;
            restored.streams++;
            if (restored.timer) return;
            restored.timer = schedule(() => {
                restored.timer = null;
                node.log(`Sending ${restored.readings} reading(s) of ${restored.streams} stream(s) saved at the last close`);
                restored.readings = 0;
                restored.streams = 0;
            }, 1000);
        }
        function takingSpool(key) {
            for (const p of spoolTakes) {
                if (p.keys.has(key)) return true;
            }
            return false;
        }
        // A stream with no stored data is typed by the first reading the cloud stores for it. 2.4.3 lost the cycles
        // waiting at a close, so after the restart its type came from what was sent then: saved cycles wait until the
        // stream has stored data, and then go, without readings at seconds sent meanwhile (those won in 2.4.3).
        function noteDeferred(key, sent) {
            const seen = deferredLive.get(key) || new Set();
            for (const record of sent) {
                const k = sentKey(record);
                if (k !== null && seen.size < 20000) seen.add(k);
            }
            if (!hasStoredData(key)) {
                deferredLive.set(key, seen);
                return;
            }
            const blocks = deferredSpool.get(key).map(b => b.filter(r => !seen.has(sentKey(r)))).filter(b => b.length > 0);
            deferredSpool.delete(key);
            deferredLive.delete(key);
            if (blocks.length > 0) {
                queueBacklog(key, blocks);
                queueFirst(new Set([key]));
                wakeDrain();
            }
        }

        // REPLAY_HELD: cache files set aside at start-up (see FileStorageCache.loadFiles) go back in front of their
        // stream's cache, for the streams this node maps; its next uploads send them. Others stay set aside.
        async function replayHeld() {
            const mapped = new Set(node.pool.getStreamKeyList());
            const restored = [];
            const kept = [];
            for (const key of new Set(node.fileCache.heldFiles().map(h => h.key))) {
                if (!mapped.has(key)) {
                    kept.push(key);
                    continue;
                }
                await lockCache(key);
                try {
                    await node.fileCache.restoreHeld(key);
                    replay.chunks.delete(key);
                    replay.backoff.delete(key);
                    restored.push(key);
                } catch (error) {
                    logError(`Failed to restore the set-aside cache of stream ${key}`, error);
                    kept.push(key);
                } finally {
                    unlockCache(key);
                }
            }
            return { restored, kept };
        }

        // Rule S2 needs this station's streams. Two tries; without them, held topics keep their name match.
        async function resolveStationList(gen) {
            if (stale(gen) || !init.s2Pending || init.s2ListResolved || init.resolving || !init.stationOk) return;
            init.resolving = true;
            let stationList = null;
            for (let attempt = 1; attempt <= 2 && !stationList; attempt++) {
                try {
                    stationList = await getStationStreams(node.pool.getPoolKey(), node.pool.getStationId());
                } catch (error) {
                    if (stale(gen)) return;
                    logWarn("Station stream list failed:", error);
                    if (attempt < 2) await delay(backoff(attempt));
                }
                if (stale(gen)) return;
            }
            init.resolving = false;
            if (init.s2ListResolved) return;          // given up on meanwhile
            init.s2ListResolved = true;
            if (!stationList) {
                healthLog('mapping', "This station's stream list could not be read; topics keep their name match, as before");
                return;
            }
            try {
                const local = new Map();
                stationList.slice()
                    .sort((a, b) => (parseServerDate(a && a.RegistrationDate) || 0) - (parseServerDate(b && b.RegistrationDate) || 0))
                    .forEach(s => {
                        if (s && s.LocalIndex !== undefined && s.LocalIndex !== null && !local.has(foldNarrow(s.LocalIndex))) {
                            local.set(foldNarrow(s.LocalIndex), s);
                        }
                    });
                init.local = local;
            } catch (error) {
                logError("Station stream list failed:", error);     // held topics keep their name match
            }
        }

        function isHeld(topic) {
            return init.s2Pending && init.s2Potential.has(topic) && !init.s2Done.has(topic);
        }

        // Called by the scheduler. Held topics are decided once this station's list is known (or given up on) and
        // a minute has passed since mapping, so the topics this node sends at start-up are known first.
        function maybeDecideS2() {
            if (!init.s2Pending) return;
            const waited = now() - init.mappedAt;
            if (!init.s2ListResolved && waited >= TIMING.s2MaxWaitMs) {
                init.s2ListResolved = true;
                healthLog('mapping', "This station's stream list is taking too long; topics keep their name match, as before");
            }
            if (!init.s2ListResolved || waited < TIMING.s2HoldMs) return;
            init.s2Pending = false;
            const decided = [];
            const tally = { moved: 0, kept: 0, example: null };
            for (const topic of init.s2Potential) {
                if (seenTopics.has(topic) && !init.s2Done.has(topic)) {
                    decideS2(topic, tally);
                    decided.push(topic);
                }
            }
            if (tally.moved + tally.kept > 0) {
                healthLog('mapping', `${tally.moved + tally.kept} topic(s) match one stream by name and another by LocalIndex in this station: ${tally.moved} now use the latter, ${tally.kept} keep the name match. Example: "${tally.example}" (details with "Show debug warnings")`);
            }
            for (const topic of decided) {
                try {
                    postHeldTags(topic);
                } catch (error) {
                    logError("Error on input:", error);     // e.g. a msg.meta that isn't text, as in 2.4.3
                }
            }
            releaseHeldBlocks();
        }

        // Cycles held for rule S2 go to the stream each topic maps to now, oldest first: the stream S2 chose, or
        // its name match (2.4.3's result when its list arrives first) if it wasn't decided. They go in front of the
        // queue as a backlog (see queueBacklog). Each held topic's first-message tags are posted, as 2.4.3 posted
        // them. Returns the keys released.
        function releaseHeldBlocks() {
            const keys = new Set();
            const topics = new Set([...init.s2HeldBlocks.keys(), ...init.s2HeldMeta.keys()]);
            for (const topic of topics) {
                init.s2Done.add(topic);         // it goes to this stream now: rule S2 never moves it
                const blocks = init.s2HeldBlocks.get(topic) || [];
                const key = node.pool.streams.nameToKey.get(topic);
                if (key && blocks.length > 0) {
                    for (const block of queueBacklog(key, blocks)) releasedBlocks.add(block);
                    keys.add(key);
                }
                try {
                    postHeldTags(topic, closed ? 'open' : undefined);   // at close: as if posted while open
                } catch (error) {
                    logError("Error on input:", error);
                }
            }
            init.s2HeldBlocks.clear();
            if (keys.size > 0) {
                queueFirst(keys);
                wakeDrain();
            }
            return keys;
        }

        // A backlog (cycles released after the rule S2 hold, or saved at the last close) goes in front of the stream's
        // waiting cycles. Its cycles are merged where that stores what sending them in turn would (see canMerge), so
        // they go out in a few requests; otherwise (a stream with no stored data yet, or with a cache) they go one at
        // a time, oldest first, as 2.4.3 sent them an interval apart.
        function queueBacklog(key, blocks) {
            let out = blocks;
            if (canMerge(key)) {
                out = [];
                for (const block of blocks) {
                    const last = out[out.length - 1];
                    if (last && last.length + block.length <= TIMING.maxBlockRecords && mergeable(last) && mergeable(block)) {
                        out[out.length - 1] = mergeBlocks(last, block);
                    } else {
                        out.push(block);
                    }
                }
            }
            queue.set(key, out.concat(queue.get(key) || []));
            sched.sequential.set(key, (sched.sequential.get(key) || 0) + out.length);
            return out;
        }

        // Puts these streams at the front of the queue (the drain serves streams in queue order)
        function queueFirst(keys) {
            const rest = Array.from(queue.entries()).filter(([key]) => !keys.has(key));
            const first = Array.from(keys).filter(key => queue.has(key)).map(key => [key, queue.get(key)]);
            queue.clear();
            for (const [key, blocks] of first.concat(rest)) queue.set(key, blocks);
        }

        // Rule S2, once per topic and before its first upload. If a topic's Name match is not the stream a
        // registration would give it (this station's stream with the same LocalIndex), keep the one written to most
        // recently; if both were written lately (two writers), keep this station's. The Name match (2.4.3's result
        // when its list arrives first) stays if the streams' data types differ, or if another topic this node
        // sends uses the other stream or would register to it (a case or space variant).
        function decideS2(topic, tally) {
            if (init.s2Done.has(topic)) return;
            init.s2Done.add(topic);
            if (!init.local) return;
            const keyByName = node.pool.streams.nameToKey.get(topic);
            const byName = init.byKey.get(keyByName);
            const own = init.local.get(foldNarrow(topic));
            if (!byName || !own || !own.StreamKey || own.StreamKey === keyByName) return;
            counters.mappingConflicts++;
            let why = null;
            if (!sentByName.has(topic)) {
                why = 'it is only written to by its stream key';       // 2.4.3 always feeds the name match then
            } else if (String(own.DataType) !== String(byName.DataType)) {
                why = 'their data types differ';
            } else {
                for (const other of seenTopics) {
                    if (other === topic) continue;
                    if (other === own.StreamKey || node.pool.streams.nameToKey.get(other) === own.StreamKey) {
                        why = `"${other}" uses the second`;
                        break;
                    }
                    if (foldWide(other) === foldWide(topic)) {
                        why = `"${other}" would register to the second`;
                        break;
                    }
                }
            }
            let moved = false;
            if (!why) {
                const tName = parseServerDate(byName.LastTimestamp);
                const tOwn = parseServerDate(own.LastTimestamp);
                const recent = Date.now() - Math.max(2 * intervalMs, TIMING.s2LiveWindowMs);
                const bothLive = tName !== null && tOwn !== null && tName >= recent && tOwn >= recent;
                if (bothLive || (tOwn || 0) > (tName || 0)) {
                    node.pool.updateStreamKey(topic, own.StreamKey);
                    init.s2Moved.add(topic);
                    moved = true;
                    // Cycles saved for this stream go out now it is mapped; a cache left for the name match (2.4.3's
                    // stream for the topic) still goes there
                    takeSpools([own.StreamKey]);
                    why = bothLive ? 'both are being written' : 'it was written more recently';
                } else {
                    why = 'it was written more recently';
                }
            }
            // A cache an earlier run left under the stream not chosen still goes to that stream
            const other = moved ? keyByName : own.StreamKey;
            if (node.fileCache.streamKeyExists(other)) continueReplay(other);
            const text = `Topic "${topic}" matches stream ${keyByName} by name and ${own.StreamKey} by LocalIndex in this station; ${moved ? 'using the second' : 'keeping the name match'} (${why})`;
            logWarn(text);
            if (tally) {
                tally[moved ? 'moved' : 'kept']++;
                tally.example = tally.example || topic;
            } else {
                healthLog('mapping', text);
            }
        }

        // A topic whose Name match another topic took under rule S2 can't be uploaded (2.4.3 had the same limit
        // when two topics shared a stream key). Say so when the topic first sends.
        function checkTopicKey(topic) {
            const key = node.pool.streams.nameToKey.get(topic);
            const holder = key ? node.pool.getStreamNameByKey(key) : null;
            if (holder && holder !== topic) {
                counters.mappingConflicts++;
                healthLog('strand', `Topic "${topic}" maps to stream ${key}, which "${holder}" already uses; its readings are not uploaded`);
            }
        }

        // The one-off stream tag post, with 2.4.3's transform and body
        function postTagsOnce(stream, meta, afterClose) {
            stream.setTagsPosted(true);
            let streamTags = meta?.split(/\s*,\s*/) || null;
            if (streamTags) {
                streamTags = _removeNameSpacePrefix(streamTags);
                streamTags = [...new Set(streamTags)];
            }
            stream.updateTags(streamTags);
            postAddStreamTags(stream.getStreamKey(), streamTags, afterClose);
        }

        // Tags of a topic that was held for rule S2 go to the stream it ended up with, using its first message's meta
        function postHeldTags(topic, afterClose) {
            const stream = node.pool.streams.streams.get(topic);
            if (stream && init.s2HeldMeta.has(topic) && stream.getStreamKey() && !stream.getTagsPosted()) {
                postTagsOnce(stream, init.s2HeldMeta.get(topic), afterClose);
            }
            init.s2HeldMeta.delete(topic);
        }

        // Read-only: reports stream keys in use that the cloud no longer lists (deleted or hidden). Never maps.
        async function refreshStreams(gen) {
            if (stale(gen)) return;
            try {
                const poolList = await getPoolStreams(node.pool.getPoolKey());
                if (stale(gen)) return;
                const listed = new Set(poolList.map(s => s && s.StreamKey));
                const vanished = Array.from(seenTopics)
                    .map(t => node.pool.streams.nameToKey.get(t))
                    .filter(k => k && !listed.has(k));
                if (vanished.length > 0) {
                    healthLog('refresh', `${vanished.length} stream key(s) in use are no longer listed by the cloud (deleted or hidden); they are still used, as before. Example: ${node.pool.getStreamNameByKey(vanished[0])}`);
                }
            } catch (error) {
                if (stale(gen)) return;
                logWarn("Stream list refresh failed:", error);
            }
            schedule(() => refreshStreams(gen), jitter(TIMING.refreshMs));
        }

        // ---------------------------------------------------------------------------------------------------------
        // Registration: serialised node-wide as in 2.4.3, coalesced per topic, never on the input path.
        // ---------------------------------------------------------------------------------------------------------
        function requestRegistration(topic) {
            if (!canRegister()) {
                reg.deferred.add(topic);                                    // registered as soon as setup completes
                return;
            }
            if (reg.queued.has(topic) || reg.inFlightTopic === topic) return;
            const st = reg.state.get(topic);
            if (st && st.notBefore > now()) return;                         // settling or backing off
            reg.queue.push(topic);
            reg.queued.add(topic);
            pumpRegistrations().catch(error => logError("Error in stream registration:", error));
        }

        async function pumpRegistrations() {
            if (reg.running) return;
            reg.running = true;
            try {
                while (reg.queue.length > 0 && !closed) {
                    const topic = reg.queue.shift();
                    reg.queued.delete(topic);
                    const gen = generation;
                    const stream = node.pool.getStreamByNameOrKey(topic);
                    if (!stream || stream.getStreamKey()) continue;         // key arrived meanwhile: nothing to do
                    const poolKey = node.pool.getPoolKey();
                    const stationId = node.pool.getStationId();
                    const dataType = stream.getDataType();
                    if (!(poolKey && stationId && topic && dataType)) continue;

                    reg.inFlightTopic = topic;
                    const startedAt = now();
                    try {
                        const created = await postAddUpdateStream(poolKey, stationId, topic, dataType);
                        // Applied even if the node closed meanwhile: close waits for it, to save the topic's readings
                        if (gen !== generation) continue;
                        if (!created || !isAnyGUID(created.StreamKey)) {
                            throw protocolError(null, "The stream registration response did not contain a StreamKey");
                        }
                        const holder = node.pool.getStreamNameByKey(created.StreamKey);
                        if (stream.getStreamKey()) {
                            // Never re-key a topic (contract rule S5)
                            counters.mappingConflicts++;
                            healthLog('mapping', `"${topic}" already had a stream key when its registration returned; keeping the existing key`);
                        } else if (holder && holder !== topic && init.s2Moved.has(holder) && node.pool.streams.nameToKey.get(holder) === created.StreamKey) {
                            // Rule S2 gave this stream to a topic that is running; it keeps it
                            node.pool.mapNameOnly(topic, created.StreamKey);
                            counters.mappingConflicts++;
                            healthLog('strand', `Topic "${topic}" registered to stream ${created.StreamKey}, which "${holder}" already uses; its readings are not uploaded`);
                        } else {
                            node.pool.updateStreamKey(topic, created.StreamKey);
                            takeSpools([created.StreamKey]);
                        }
                        reg.state.delete(topic);
                    } catch (error) {
                        // Recorded even after CREATE_POOL: an unknown outcome still needs its settle period
                        if (closed) continue;
                        registrationFailed(topic, error, now() - startedAt);
                    } finally {
                        reg.inFlightTopic = null;
                    }
                }
            } finally {
                reg.running = false;
            }
        }

        // How long to wait after a request with an unknown outcome before re-posting it: the API never cancels,
        // so the first insert may still commit, and a re-POST inside that window is how duplicates arise.
        function settleMs(elapsedMs) {
            return Math.min(Math.max(TIMING.regSettleMaxMs, regSettleMinMs), Math.max(regSettleMinMs, 2 * elapsedMs));
        }

        function registrationFailed(topic, error, elapsedMs) {
            const st = reg.state.get(topic) || { permanentFailures: 0, notBefore: 0 };
            const kind = classifyFailure(error);
            const status = error.response && error.response.status;
            if (kind === 'unknown') {
                const settle = settleMs(elapsedMs);
                st.notBefore = now() + settle;
                healthLog('register', `Stream registration outcome unknown (${errorCode(error)}) for "${topic}"; waiting ${Math.round(settle / 1000)}s before retrying to avoid a duplicate stream`);
            } else if (status === 403 || (status === 500 && topic.length > 255)) {
                st.permanentFailures++;
                if (st.permanentFailures >= 3) {
                    st.notBefore = now() + Math.min(TIMING.regPermanentBackoffMaxMs, 30000 * Math.pow(2, st.permanentFailures - 3));
                }
                healthLog('register', `Stream registration rejected (${errorCode(error)}) for "${topic}"`);
            } else {
                st.permanentFailures = 0;
                healthLog('register', `Stream registration failed (${errorCode(error)}) for "${topic}"; retrying on its next message`);
            }
            reg.state.set(topic, st);
            logError(`Error loading stream: streamName: ${topic}`, error);
        }

        // ---------------------------------------------------------------------------------------------------------
        // Upload scheduling: one timer chain, one drain at a time, bounded adaptive concurrency. As in 2.4.3,
        // each upload cycle's readings for a stream are one request (with the stream's cache in front), and a
        // stream's requests can overlap, up to perKeyConcurrency. Request bodies are exactly 2.4.3's.
        // ---------------------------------------------------------------------------------------------------------
        function startScheduler() {
            const tick = () => {
                if (closed) return;
                try {
                    maybeDecideS2();
                    if (now() - sched.lastEnqueueAt >= intervalMs) {
                        enqueueAll();
                        sched.lastEnqueueAt = now();
                    }
                    if (queueLength() > 0 && !sched.draining) {
                        runDrain();
                    }
                } catch (error) {
                    logError("Error in Upload Timer:", error);
                    healthLog('scheduler', `Upload scheduler error (${errorCode(error)}); it carries on`);
                } finally {
                    schedule(tick, TIMING.schedulerTickMs);
                }
            };
            schedule(tick, TIMING.schedulerTickMs);
        }

        function enqueueAll() {
            enqueueKeys(node.pool.getStreamKeyList());
        }

        // Each upload cycle's readings for a stream become one block, typed by that cycle as in 2.4.3. A stream far
        // behind (maxQueuedBlocksPerKey blocks waiting) gets its newest block merged into the last waiting one, as
        // sequential requests would store them, up to 2.4.3's largest block, if neither can be rejected. Only a stream more than
        // maxQueuedBlocksHardPerKey blocks behind has its oldest block moved to the cache.
        function enqueueKeys(keys) {
            let added = false;
            for (const key of keys) {
                if (!key) continue;
                try {
                    const stream = node.pool.getStreamByNameOrKey(key);
                    if (!stream || stream.getRecordCount() === 0) continue;
                    const data = stream.getAllValues();
                    if (data.length === 0) continue;
                    const name = stream.getStreamName();
                    if (isHeld(name)) {
                        // Rule S2 may still move the topic: its cycles wait, one block each, until it is decided
                        if (!init.s2HeldBlocks.has(name)) init.s2HeldBlocks.set(name, []);
                        init.s2HeldBlocks.get(name).push(data);
                        continue;
                    }
                    const blocks = queue.get(key) || [];
                    if (blocks.length >= TIMING.maxQueuedBlocksPerKey) {
                        counters.backlogMerges++;
                        healthLog('backlog', `Uploads are behind for stream ${key}; its waiting readings are combined into fewer requests`);
                        const last = blocks[blocks.length - 1];
                        if (last.length + data.length <= TIMING.maxBlockRecords && mergeable(last) && mergeable(data) && canMerge(key)) {
                            blocks[blocks.length - 1] = mergeBlocks(last, data);
                        } else {
                            blocks.push(data);
                            if (blocks.length > TIMING.maxQueuedBlocksHardPerKey) {
                                spillToCache(key, blocks.shift(), blocks);
                            }
                        }
                    } else {
                        blocks.push(data);
                    }
                    queue.set(key, blocks);
                    added = true;
                } catch (error) {
                    logError("Error in Enqueue Data:", error);
                }
            }
            if (added) wakeDrain();
        }

        // Only blocks the cloud can't reject are merged: one rejected record fails its whole request, and a merged
        // request would take the other cycles down with it (into the cache). Rejected: a Val that is text.
        function mergeable(block) {
            return block.every(r => {
                const t = Date.parse(r.Ts);
                return t > 0 && t < MAX_SERVER_DATE_MS &&           // the cloud rejects a date past year 9999
                    (r.Val === null || r.Val === undefined || typeof r.Val === 'number') &&
                    (r.ValStr === null || r.ValStr === undefined || typeof r.ValStr === 'string');
            });
        }

        // A later reading wins over an earlier one with the same timestamp, as when the blocks are sent in turn
        function mergeBlocks(earlier, later) {
            const laterTs = new Set(later.map(r => r.Ts));
            return earlier.filter(r => !laterTs.has(r.Ts)).concat(later);
        }

        // Last resort for a stream that is maxQueuedBlocksHardPerKey full blocks behind: its oldest block goes to the
        // cache, under the stream's cache lock, without readings that newer waiting blocks overwrite anyway
        function spillToCache(key, block, newer) {
            const newerTs = new Set();
            newer.forEach(b => b.forEach(r => newerTs.add(r.Ts)));
            const records = block.filter(r => !newerTs.has(r.Ts));
            counters.backlogSpills++;
            healthLog('backlog-spill', `Uploads are far behind for stream ${key}; its oldest waiting readings go to the cache`);
            lockCache(key)
                .then(() => cacheRecords(key, records))
                .catch(error => logError("Error in Cache Spill:", error))
                .finally(() => unlockCache(key));
        }

        function queueLength() {
            let n = 0;
            queue.forEach(blocks => { n += blocks.length; });
            return n;
        }

        function wakeDrain() {
            const wake = sched.wake;
            sched.wake = null;
            if (wake) wake();
        }

        // Uploads run while the node is open, and after close only to send cycles held for rule S2 (see close)
        function canSend() {
            return !closed || flushing;
        }

        // Until a stream has data in the cloud, the cloud types it by the first reading it stores. 2.4.3 sent the
        // stream's cache in front of every request, so the cache's oldest reading decided. For such a stream with a
        // cache, requests go one at a time and always carry the cache, to keep that.
        function needsCacheFirst(key) {
            if (hasStoredData(key)) return false;
            return memoryPending.has(key) || node.fileCache.streamKeyExists(key);
        }

        function hasStoredData(key) {
            if (uploadedKeys.has(key)) return true;
            const listed = init.byKey && init.byKey.get(key);
            return !!(listed && listed.LastTimestamp);
        }

        // Merging a stream's cycles into one request stores what sending them in turn would, only once the stream's
        // type is settled (it has stored data: the cloud types an empty stream by a request's first reading) and no
        // cache goes in front (within one request the first of two equal timestamps wins; a later request overwrites)
        function canMerge(key) {
            return hasStoredData(key) && !memoryPending.has(key) && !node.fileCache.streamKeyExists(key);
        }

        // Whether the cloud stores a request's first record: a finite number with no text,
        // or non-empty text with no number, stamped after 1970 and not more than ten years ahead. A 200 that stores
        // nothing leaves an empty stream empty, so the stream still needs its cache first.
        function firstRecordIsStored(record) {
            if (!record) return false;
            const t = Date.parse(record.Ts);
            if (!(t > 0) || t > Date.now() + 10 * 365.25 * 86400000) return false;
            const noText = record.ValStr === null || record.ValStr === undefined || record.ValStr === '';
            if (typeof record.Val === 'number' && Number.isFinite(record.Val) && noText) return true;
            return (record.Val === null || record.Val === undefined) && typeof record.ValStr === 'string' && record.ValStr !== '';
        }

        async function drainLoop() {
            const inFlight = new Set();
            const perKey = sched.perKey;
            while (canSend()) {
                // Rounds give every waiting stream one request each, oldest block first, until the cap is reached
                // or no stream can take another (streams take turns)
                let launched = true;
                while (launched && inFlight.size < limiter.cap && canSend()) {
                    launched = false;
                    for (const key of Array.from(queue.keys())) {
                        if (inFlight.size >= limiter.cap) break;
                        if (closed && !flushKeys.has(key)) continue;
                        // Cycles saved at the last close are being read back: they go first (see takeSpool)
                        if (takingSpool(key)) continue;
                        const cacheFirst = needsCacheFirst(key);
                        const oneAtATime = cacheFirst || sched.sequential.has(key);
                        if ((perKey.get(key) || 0) >= (oneAtATime ? 1 : TIMING.perKeyConcurrency)) continue;
                        // Such a stream's large cache needs a replay slot: wait in the queue, not in the drain's slots
                        if (cacheFirst && replay.active >= TIMING.maxConcurrentReplays && needsSlot(key)) continue;
                        const blocks = queue.get(key);
                        if (!blocks) continue;
                        const block = blocks.shift();
                        queue.delete(key);
                        if (blocks.length > 0) queue.set(key, blocks);
                        const backlogLeft = (sched.sequential.get(key) || 0) - 1;
                        if (backlogLeft > 0 && blocks.length > 0) sched.sequential.set(key, backlogLeft); else sched.sequential.delete(key);
                        perKey.set(key, (perKey.get(key) || 0) + 1);
                        const released = releasedBlocks.has(block);
                        if (released) releasedInFlight.set(key, (releasedInFlight.get(key) || 0) + 1);
                        const p = uploadBlock(key, block)
                            .catch(error => logError("Error in Upload Post:", error))
                            .then(() => {
                                inFlight.delete(p);
                                const n = perKey.get(key) - 1;
                                if (n > 0) perKey.set(key, n); else perKey.delete(key);
                                if (released) {
                                    const r = releasedInFlight.get(key) - 1;
                                    if (r > 0) releasedInFlight.set(key, r); else releasedInFlight.delete(key);
                                }
                            });
                        inFlight.add(p);
                        launched = true;
                    }
                }
                if (inFlight.size === 0) break;
                // Wait for a request to finish or for new blocks, so one slow request doesn't hold up the rest
                await Promise.race([...inFlight, new Promise(resolve => { sched.wake = resolve; })]);
                sched.wake = null;
            }
        }

        function runDrain() {
            if (sched.draining) return sched.draining;
            const p = drainLoop()
                .catch(error => logError("Error in Upload Post Timer:", error))
                .finally(() => {
                    if (sched.draining === p) sched.draining = null;
                });
            sched.draining = p;
            return p;
        }

        // A stream's cache is read by one request at a time, which holds this lock until it has deleted or kept the
        // file. Appends after a failure wait for it, so nothing is appended between a read and its delete.
        function tryLockCache(key) {
            if (cacheLocks.has(key)) return false;
            cacheLocks.set(key, []);
            heldLocks.set(key, (heldLocks.get(key) || 0) + 1);
            return true;
        }
        function lockCache(key) {
            return new Promise(resolve => {
                if (tryLockCache(key)) return resolve();
                cacheLocks.get(key).push(() => {
                    heldLocks.set(key, (heldLocks.get(key) || 0) + 1);
                    resolve();
                });
            });
        }
        function unlockCache(key) {
            const mine = (heldLocks.get(key) || 1) - 1;
            if (mine > 0) heldLocks.set(key, mine); else heldLocks.delete(key);
            const waiters = cacheLocks.get(key);
            if (waiters && waiters.length > 0) {
                waiters.shift()();          // hand the lock to the next waiter
            } else {
                cacheLocks.delete(key);
            }
        }

        // Whether a request may send the stream's cache in front of its block, as 2.4.3 does: not, for a stream that
        // already has data in the cloud, if sending it failed recently
        function mayReplay(key, cacheFirst) {
            const backoff = replay.backoff.get(key);
            return cacheFirst || !(backoff && backoff.until > now());
        }

        // Large caches, and every chunked one (its record of what was sent is read with it), take one of a few slots,
        // so that many of them can't be in memory at once
        function needsSlot(key) {
            return node.fileCache.isChunked(key) || node.fileCache.fileSize(key) > TIMING.replaySlotBytes;
        }
        function tryAcquireReplaySlot() {
            if (replay.active < TIMING.maxConcurrentReplays) {
                replay.active++;
                return true;
            }
            return false;
        }
        function acquireReplaySlot() {
            if (tryAcquireReplaySlot()) return Promise.resolve();
            return new Promise(resolve => replay.waiters.push(resolve));
        }
        function releaseReplaySlot() {
            const next = replay.waiters.shift();
            if (next) {
                next();                                  // a waiter takes the slot over
            } else {
                replay.active--;
                // A cache that found no free slot goes now, without waiting for its stream's next readings
                const waiting = replay.waitingForSlot.values().next();
                if (!waiting.done) {
                    replay.waitingForSlot.delete(waiting.value);
                    continueReplay(waiting.value);
                }
                wakeDrain();                             // a stream waiting in the queue for a slot can go
            }
        }

        // After a request carrying the cache fails, new readings go without it for a while (1 min, doubling up to
        // 30 min). Uploads that succeed meanwhile bring the retry forward (see liveUploadSucceeded), so a cache built
        // up during an outage is sent as soon as the cloud is back, as in 2.4.3. A chunked cache whose chunk failed
        // tries a chunk half the size at once instead (see chunkState): a slow link, or a proxy limiting request size.
        function replayFailed(key) {
            const chunks = replay.chunks.get(key);
            if (chunks && chunks.size > TIMING.replayChunkMin) {
                chunks.ceiling = chunks.size;
                chunks.size = Math.max(TIMING.replayChunkMin, Math.floor(chunks.size / 2));
                chunks.successes = 0;
                continueReplay(key);
                return;
            }
            const backoff = replay.backoff.get(key) || { failures: 0, until: 0 };
            backoff.failures++;
            backoff.outageSeen = false;
            const wait = Math.min(TIMING.replayBackoffMaxMs, TIMING.replayBackoffMinMs * Math.pow(2, backoff.failures - 1));
            backoff.until = now() + wait;
            replay.backoff.set(key, backoff);
            healthLog('replay', `Sending the upload cache of stream ${key} failed; new readings go without it, and the cache is tried again within ${Math.round(wait / 1000)}s`);
        }

        // A stream's own upload without the cache failed too: the cache failed because of an outage, not its size
        function liveUploadFailed(key) {
            const backoff = replay.backoff.get(key);
            if (backoff) backoff.outageSeen = true;
        }

        // While live uploads work, the cache is tried again at most once a minute (and at once the first time),
        // whatever the backoff, so a cache that failed during flapping goes out soon after the cloud is stable
        function liveUploadSucceeded(key) {
            const backoff = replay.backoff.get(key);
            if (!backoff) return;
            if (backoff.outageSeen) {
                replay.backoff.delete(key);        // the cloud is back: the cache goes with the next upload
                return;
            }
            const t = now();
            if (backoff.lastQuickRetryAt === undefined || t - backoff.lastQuickRetryAt >= TIMING.replayBackoffMinMs) {
                backoff.lastQuickRetryAt = t;
                backoff.until = 0;
            }
        }

        // A cache past 30 KB (in replay/) goes in chunks, oldest first, in front of the stream's next blocks; while
        // chunks are left, the next goes at once, without waiting for new readings. A chunk that fails is halved for
        // the next request (down to replayChunkMin, then the cache backs off); after a success the size doubles, but
        // stays under three quarters of the size that failed until 10 chunks in a row have gone.
        // 2.4.3 sent a cache whole, in one request, in front of a block: the first of two readings at the same second
        // wins within a request, and a later request overwrites. So the first chunk goes as 2.4.3's request did, and a
        // later chunk leaves out readings at seconds already sent by an earlier chunk of the file, by readings sent
        // after the first chunk, or by its own request's block (readings of the same kind, number or text: the cloud
        // drops the other kind for the stream). Until the stream has stored data, a chunk after the first starts with
        // an empty record, which the cloud doesn't store and which can't re-type the stream: the file's first reading
        // typed it, as in 2.4.3.
        function chunkState(key) {
            if (!replay.chunks.has(key)) replay.chunks.set(key, { size: TIMING.replayChunkStart, ceiling: 0, successes: 0 });
            return replay.chunks.get(key);
        }
        async function chunkRecords(key, read, records, block) {
            if (node.fileCache.dedupeApplies(key)) {
                const sent = await node.fileCache.readSent(key);
                const inRequest = new Set(read.start > 0 ? sentKeys(block) : []);
                records = records.filter(r => {
                    const k = sentKey(r);
                    return k === null || !(sent.has(k) || inRequest.has(k));
                });
            }
            if (read.start > 0 && records.length > 0 && !hasStoredData(key)) {
                records = [{ Ts: records[0].Ts, Val: null, ValStr: null, Calculated: false }].concat(records);
            }
            return records;
        }
        function sentKeys(records) {
            const keys = [];
            for (const record of records) {
                const k = sentKey(record);
                if (k !== null) keys.push(k);
            }
            return keys;
        }
        // A reading's second and kind (positive for a number, negative for text), or null if the cloud stores neither
        function sentKey(record) {
            const t = Date.parse(record.Ts);
            if (!(t > 0)) return null;
            if (typeof record.Val === 'number' && Number.isFinite(record.Val)) return t;
            if (typeof record.ValStr === 'string') return -t;
            return null;
        }
        // The cloud accepted a request carrying part of the stream's cache: that part is removed, as 2.4.3 deletes a
        // cache it sent (and only what was read and sent: 2.4.3 also deleted caches it didn't send). block: the
        // request's block. What it sent is recorded next to the file (see chunkRecords).
        async function chunkSent(key, chunk, block) {
            const chunks = replay.chunks.get(key);
            if (chunk.done) {
                await node.fileCache.deleteFile(key);
                replay.chunks.delete(key);
                return;
            }
            if (node.fileCache.dedupeApplies(key)) {
                await node.fileCache.addSent(key, sentKeys(chunk.records).concat(chunk.start > 0 ? sentKeys(block) : []));
            }
            if (!(await node.fileCache.commitChunk(key, chunk.end, chunk.head))) {
                healthLog('cache', `Could not record how much of the upload cache of stream ${key} was sent (${errorCode(node.fileCache.lastError)}); after a restart that part is sent again`);
            }
            if (chunks) {
                chunks.successes++;
                if (chunks.ceiling && chunks.successes >= 10) chunks.ceiling = 0;
                const cap = chunks.ceiling ? Math.max(TIMING.replayChunkMin, Math.floor(chunks.ceiling * 3 / 4)) : TIMING.replayChunkMax;
                chunks.size = Math.max(chunks.size, Math.min(cap, chunks.size * 2));
            }
            continueReplay(key);
        }
        // Readings sent while a chunked cache is going out win over the rest of it (see chunkState)
        async function liveSentDuringReplay(key, block) {
            if (!node.fileCache.isChunked(key) || node.fileCache.pendingSize(key) === node.fileCache.fileSize(key)) return;
            if (!node.fileCache.checked.has(key) || node.fileCache.dedupeApplies(key)) {
                await node.fileCache.addSent(key, sentKeys(block));
            }
        }
        // Another request for the stream, which carries the cache's next chunk if no block is waiting
        function continueReplay(key) {
            if (!closed && !queue.has(key)) {
                queue.set(key, [[]]);
                wakeDrain();
            }
        }

        // Uploads one block. The request that gets the stream's cache lock also sends what is kept in memory and,
        // when allowed, the stream's cache, in front of the block as 2.4.3 does: the whole cache while it is within
        // 30 KB, as 2.4.3 sends it, or the next chunk of a bigger one. A large cache goes only if a replay slot is
        // free (it is tried again with a later request), except for a stream that needs its cache first.
        // Returns false if it failed; the block is then in the cache, or, aborted at close, saved for the next start.
        async function uploadBlock(streamKey, newData) {
            const uri = `${node.rootUrlv2}streams/${streamKey}/logs`;
            // Started while the node was open: sent and, on failure, cached even after close, as 2.4.3's requests
            // in flight were. Started by the close flush: sent only while the flush runs.
            const startedOpen = !closed;
            const seq = launches++;
            const request = { key: streamKey, aborted: false, add: abort => dataRequests.set(abort, request), delete: abort => dataRequests.delete(abort) };
            const cacheFirst = needsCacheFirst(streamKey);
            let holdsCache = tryLockCache(streamKey);
            if (!holdsCache && cacheFirst) {
                await park(streamKey, lockCache(streamKey));    // a spill or a failed request's append holds it: carry the cache
                holdsCache = true;
            }
            let replaying = false;
            try {
                const allDataToSend = [];
                let pending = null;
                let chunk = null;               // what this request took from the cache
                let chunks = null;
                let fromCache = [];
                if (holdsCache) {
                    const dataType = node.pool.getStreamByNameOrKey(streamKey)?.getDataType();
                    if (dataType && node.fileCache.streamKeyExists(streamKey) && mayReplay(streamKey, cacheFirst)) {
                        let send = true;
                        if (needsSlot(streamKey)) {
                            if (cacheFirst) {
                                await park(streamKey, acquireReplaySlot());
                                replaying = true;
                            } else if (tryAcquireReplaySlot()) {
                                replaying = true;
                            } else {
                                send = false;
                                replay.waitingForSlot.add(streamKey);
                            }
                        }
                        if (send) {
                            chunks = node.fileCache.isChunked(streamKey) ? chunkState(streamKey) : null;
                            const read = chunks
                                ? await node.fileCache.readChunk(streamKey, chunks.size, TIMING.replayChunkMaxBytes)
                                : await node.fileCache.readChunk(streamKey, Infinity);
                            if (read.readOk) {
                                chunk = read;
                            } else {
                                logError(`Failed to read cache for stream ${streamKey}`, node.fileCache.lastError);
                            }
                        }
                    }
                    pending = memoryPending.get(streamKey) || null;
                    memoryPending.delete(streamKey);
                }
                let left = 0;
                if (chunk) {
                    fromCache = chunk.records.filter(FileStorageCache.serverDate);
                    left += chunk.records.length - fromCache.length;
                    if (chunks) fromCache = await chunkRecords(streamKey, chunk, fromCache, newData);
                }
                if (pending) {
                    const usable = pending.filter(FileStorageCache.serverDate);
                    left += pending.length - usable.length;
                    pending = usable.length > 0 ? usable : null;
                }
                if (left > 0) quarantined(streamKey, left);
                // What was kept in memory (failed requests 2.4.3 would have appended to the cache) goes after the cache
                const live = pending ? pending.concat(newData) : newData;
                for (const record of fromCache) allDataToSend.push(record);   // no spread: caches can be large
                if (pending) {
                    for (const record of pending) allDataToSend.push(record);
                }
                for (const record of newData) allDataToSend.push(record);
                // 2.4.3's request with such a reading was rejected, so it never typed a stream with no stored data: an
                // empty record goes first, so the reading that is now first can't type it either
                const first = allDataToSend[0];
                if (left > 0 && first && !hasStoredData(streamKey) && !((first.Val === null || first.Val === undefined) && (first.ValStr === null || first.ValStr === undefined))) {
                    allDataToSend.unshift({ Ts: first.Ts, Val: null, ValStr: null, Calculated: false });
                }
                if (allDataToSend.length === 0) {
                    logInfo(`No data to upload for stream ${streamKey}`);
                    if (chunk) await chunkSent(streamKey, chunk, newData);
                    return true;
                }

                if (stoppedByClose(streamKey)) {
                    keepForClose(streamKey, seq, newData, pending);
                    return false;
                }
                const startedAt = now();
                let res;
                let body;
                try {
                    body = JSON.stringify(allDataToSend);   // inside the try: a BigInt throws, and 2.4.3 cached the batch
                    res = await httpRequest('post', uri, body, false, startedOpen ? 'open' : 'flush', request);
                    if (!isLogsAccepted(res)) {
                        throw protocolError(res);
                    }
                } catch (error) {
                    if (closed && (request.aborted || isNodeClosed(error))) {
                        // Aborted at close: saved with the waiting cycles (see close), not counted as a failure. What
                        // was kept in memory goes back there; the cache stays as it is.
                        keepForClose(streamKey, seq, newData, pending);
                        return false;
                    }
                    noteUploadFailure(error);
                    logError(`Failed to upload stream ${streamKey}`, error);
                    if (fromCache.length > 0) replayFailed(streamKey); else liveUploadFailed(streamKey);
                    // Same as 2.4.3: keep the new data in the cache; cached data stays where it is
                    if (!holdsCache) {
                        await lockCache(streamKey);
                        holdsCache = true;
                    }
                    await cacheRecords(streamKey, live);
                    return false;
                }

                if (firstRecordIsStored(allDataToSend[0])) {
                    uploadedKeys.add(streamKey);
                }
                if (deferredSpool.has(streamKey)) noteDeferred(streamKey, allDataToSend);
                noteUploadSuccess();
                if (bpChkShowDebugWarnings) {
                    // A small summary. 2.4.3 dumped the whole axios response here, which serialised every live socket
                    // and the API key, and locked up Node-RED under load.
                    logInfo(`Uploaded stream "${node.pool.getStreamNameByKey(streamKey) || "Unknown"}" (${streamKey}): HTTP ${res.status}, ${allDataToSend.length} records, ${Buffer.byteLength(body)} bytes, ${Math.round(now() - startedAt)} ms`);
                }
                if (chunk) {
                    await chunkSent(streamKey, chunk, newData);
                    replay.backoff.delete(streamKey);
                } else {
                    await liveSentDuringReplay(streamKey, newData);
                    liveUploadSucceeded(streamKey);
                }
                return true;
            } finally {
                if (replaying) releaseReplaySlot();
                if (holdsCache) unlockCache(streamKey);
            }
        }

        // Cached readings with a date the cloud can't take are left out of the request: they get it rejected every time
        // (2.4.3 was then stuck until a restart deleted the cache)
        function quarantined(key, n) {
            counters.quarantined += n;
            healthLog('quarantine', `${n} cached reading(s) of stream ${key} have a date the cloud can't take (outside years 0001-9999, such as a time given in milliseconds); they are left out`);
        }

        // Writes records to the cache; if that fails, keeps up to 2,000 per stream in memory (oldest dropped).
        async function cacheRecords(streamKey, records) {
            const ok = await node.fileCache.appendData(streamKey, records);
            if (ok) return;
            counters.cacheWriteFailures++;
            const err = node.fileCache.lastError;
            healthLog('cache', `Could not write the upload cache (${(err && (err.code || err.message)) || 'unknown error'}); keeping unsent data in memory (up to 2,000 readings per stream)`);
            const kept = (memoryPending.get(streamKey) || []).concat(records);
            const excess = kept.length - 2000;
            if (excess > 0) {
                kept.splice(0, excess);
                counters.memoryEvictions += excess;
            }
            memoryPending.set(streamKey, kept);
        }

        // Concurrency grows by 2 every 5 successes while a backlog waits (2.4.3 added workers without limit); it
        // halves on timeouts and connection errors.
        function noteUploadSuccess() {
            health.consecutiveUploadFailures = 0;
            health.lastUploadOkAt = Date.now();
            limiter.successesSinceChange++;
            if (limiter.successesSinceChange >= 5 && limiter.cap < TIMING.concurrencyMax && queueLength() > 0) {
                limiter.cap = Math.min(TIMING.concurrencyMax, limiter.cap + 2);
                limiter.successesSinceChange = 0;
            }
        }

        function noteUploadFailure(error) {
            health.consecutiveUploadFailures++;
            health.lastUploadError = errorCode(error);
            const kind = classifyFailure(error);
            if (kind === 'unknown' || kind === 'offline') {
                limiter.cap = Math.max(TIMING.concurrencyMin, Math.floor(limiter.cap / 2));
                limiter.successesSinceChange = 0;
                if (closed && flushing) endFlush();     // the cloud is unreachable: save the rest instead (see close)
            }
            healthLog('upload', `Uploads failing (${health.lastUploadError}); unsent data is kept in the cache and retried`);
        }

        // ---------------------------------------------------------------------------------------------------------
        // Status. Legacy nodes: exactly 2.4.3's text, colour and 1 s repaint. Health status is opt-in.
        // ---------------------------------------------------------------------------------------------------------
        function startUiTimer() {
            const tick = () => {
                if (closed) return;
                try {
                    if (healthStatus) {
                        healthStatusTick();
                    } else {
                        const text = legacyCounterText();
                        if (text !== null) {
                            updateStatusMsg({ fill: "blue", shape: "dot", text });
                        }
                    }
                } catch (error) {
                    logError("Error in Timer:", error);
                }
                schedule(tick, TIMING.uiTickMs);
            };
            schedule(tick, TIMING.uiTickMs);
        }

        // 2.4.3's status timer, reproduced exactly: its own epoch, the configured interval as entered, and no
        // repaint on the tick where the countdown drops below zero.
        function legacyCounterText() {
            const t = now();
            // 50 ms of slack: a 1 s timer can fire a hair before the second is up by this clock, which made the
            // countdown skip a beat at random (2.4.3 had the same jitter)
            const elapsedSeconds = Math.floor((t - lastUiCheckAt + 50) / 1000);
            const remainingSeconds = configuredInterval - elapsedSeconds;
            if (remainingSeconds < 0) {
                lastUiCheckAt = t;
                return null;
            }
            return countersText(formatDateToDdHhMmSs(remainingSeconds));
        }

        function healthStatusTick() {
            const remaining = Math.max(0, Math.ceil((intervalMs - (now() - sched.lastEnqueueAt)) / 1000));
            const text = countersText(formatDateToDdHhMmSs(remaining));
            if (!canRegister() && init.lastError) {
                const retryIn = Math.max(0, Math.round((init.retryAt - now()) / 1000));
                updateStatusMsg({ fill: "red", shape: "ring", text: `Cloud init failed: ${init.lastError}, retry ${retryIn}s · ${text}` });
            } else if (health.consecutiveUploadFailures > 0) {
                const lastOk = health.lastUploadOkAt ? new Date(health.lastUploadOkAt).toTimeString().slice(0, 5) : "never";
                updateStatusMsg({ fill: "yellow", shape: "ring", text: `Uploads failing ×${health.consecutiveUploadFailures}, last OK ${lastOk} · ${text}` });
            } else {
                updateStatusMsg({ fill: "blue", shape: "dot", text });
            }
        }

        function countersText(formattedTime) {
            const cacheSize = node.fileCache.getSize()
            const totalPoolRecordCount = node.pool.getCountOfAllRecords();
            const streamCount = node.pool.getStreamCount();
            let message = `In:(${totalPoolRecordCount}) Out:(${queueLength()}) Time:(${formattedTime}) Streams:(${streamCount})`;
            if (cacheSize > 0) {
                const storedKeys = node.fileCache.listStoredKeys();
                const countPoolCachedStreams = Array.from(storedKeys || []).reduce((count, [key]) => {
                    return count + (node.pool.hasStreamKey(key) ? 1 : 0);
                }, 0);
                if (countPoolCachedStreams > 0) {
                    message = `In:(${totalPoolRecordCount}) Out:(${queueLength()}) Time:(${formattedTime}) Streams:(${streamCount}) Cached:(${countPoolCachedStreams})`;
                }
            }
            return message;
        }

        // ---------------------------------------------------------------------------------------------------------
        // HTTP. Bodies, URLs and headers are 2.4.3's.
        // ---------------------------------------------------------------------------------------------------------
        async function getPoolStreams(poolKey) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/streams`;
            const res = await httpRequest('get', uri);
            if (!Array.isArray(res.data)) {
                throw protocolError(res);
            }
            return res.data;
        }

        async function getStationStreams(poolKey, stationId) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/stations/${stationId}/streams`;
            const res = await httpRequest('get', uri);
            if (!Array.isArray(res.data)) {
                throw protocolError(res);
            }
            return res.data;
        }

        async function postAddUpdatePool(poolName) {
            const uri = `${node.rootUrlv2}pools`;
            const res = await httpRequest('post', uri, {
                Poolname: poolName,
                Public: isPublic,
                Virtual: isVirtual
            });
            if (isHtml(res)) throw protocolError(res);
            return res.data;
        }

        function postAddPoolTags(poolKey, poolTags) {
            const uri = `${node.rootUrlv3}pool/${poolKey}/tags`;
            if (!poolTags || poolTags.length === 0) return;
            const tags = fixTags(poolTags);
            withTagSlot(() => httpRequest('post', uri, tags))
                .then(res => {
                    if (!(res.status == 204 || res.status == 200)) {
                        logWarn("Error pushing tags to pool: ", `${res.status}`);
                    }
                })
                .catch(error => {
                    if (isNodeClosed(error)) return;        // the node closed first: the next start posts them
                    logError(`Error loading pool: ${uri}`, error);
                    healthLog('tags', `Posting pool tags failed (${errorCode(error)})`);
                });
        }

        async function postAddUpdateStation(poolKey, poolName) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/stations`;
            const stationName = cleanString(poolName || "1");
            const res = await httpRequest('post', uri, JSON.stringify(stationName));
            if (isHtml(res) || !res.data) throw protocolError(res);
            return res.data.StationID;
        }

        async function postAddUpdateStream(poolKey, stationId, streamName, dataType) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/stations/${stationId}/streams`;
            const res = await httpRequest('post', uri, {
                "LocalIndex": streamName,
                "StreamName": streamName,
                "Description": streamName,
                "Public": isPublic,
                "DataType": dataType
            });
            if (isHtml(res)) throw protocolError(res);
            return res.data;
        }

        function postAddStreamTags(streamKey, tags, afterClose) {
            const uri = `${node.rootUrlv3}stream/${streamKey}/tags`;
            if (!tags || tags.length === 0) return;
            const body = fixTags(tags);
            withTagSlot(() => httpRequest('post', uri, body, false, afterClose))
                .then(res => {
                    if (!(res.status == 204 || res.status == 200)) {
                        logWarn("Error pushing tags to stream: ", `${res.status}`);
                    }
                })
                .catch(error => {
                    if (isNodeClosed(error)) return;        // the node closed first: the next start posts them
                    logError(`Error loading tags: ${uri}`, error);
                    healthLog('tags', `Posting stream tags failed (${errorCode(error)})`);
                });
        }

        // Tag POSTs share a small limiter so a restart can't open thousands of connections at once.
        function withTagSlot(fn) {
            return new Promise((resolve, reject) => {
                const run = () => {
                    tagLimiter.active++;
                    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                        tagLimiter.active--;
                        const next = tagLimiter.waiting.shift();
                        if (next) next();
                    });
                };
                if (tagLimiter.active < TIMING.tagConcurrency) run(); else tagLimiter.waiting.push(run);
            });
        }

        // One request with a deadline. POSTs follow only same-host 307/308 redirects; GETs follow as before
        // and keep 2.4.3's timeout (a longer one would change which streams topics map to on large pools).
        // afterClose: a POST may still be sent after close if it was started while the node was open, or is a held
        // topic's tag post ('open'), or by the close flush while it runs ('flush'); see close.
        // track: told the request's abort while it runs (add, then delete), so close can abort uploads in flight.
        async function httpRequest(method, url, data, redirected, afterClose, track) {
            if (closed && !(afterClose === 'open' || (afterClose === 'flush' && flushing))) {
                throw Object.assign(new Error("Node closed"), { code: 'ERR_NODE_CLOSED' });
            }
            const bytes = data === undefined ? 0 : Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data));
            // Configured timeout as is; 0/NaN gets a deadline just past the gateway's cut (plus upload time at ~128 kbit/s)
            const deadline = timeoutMs > 0 ? timeoutMs : (gatewayCutSecs() + 15) * 1000 + Math.ceil(bytes / 16);
            const cfg = { method, url, timeout: deadline };
            if (data !== undefined) cfg.data = data;
            let hardTimer = null;
            let abort = null;
            if (method !== 'get') {
                cfg.maxRedirects = 0;
                if (AbortCtl) {
                    const ctl = new AbortCtl();
                    cfg.signal = ctl.signal;
                    abort = () => ctl.abort();
                } else if (axios.CancelToken) {
                    const src = axios.CancelToken.source();
                    cfg.cancelToken = src.token;
                    abort = () => src.cancel('deadline');
                }
                if (abort) {
                    hardTimer = setTimeout(abort, Math.min(MAX_TIMER_MS, deadline + TIMING.hardDeadlineGraceMs));
                    if (track) track.add(abort);
                }
            }
            try {
                return await axiosInstance.request(cfg);
            } catch (error) {
                const status = error.response && error.response.status;
                if ((status === 307 || status === 308) && method !== 'get' && !redirected) {
                    const location = error.response.headers && error.response.headers.location;
                    if (location) {
                        const target = new URL(location, url);
                        if (target.host === new URL(url).host) {
                            return httpRequest(method, target.href, data, true, afterClose, track);
                        }
                    }
                }
                throw error;
            } finally {
                if (hardTimer) clearTimeout(hardTimer);
                if (track && abort) track.delete(abort);
            }
        }

        function gatewayCutSecs() {
            const host = api_endpoint.toLowerCase().split(/[/:]/)[0];
            if (host === 'api.bitpool.com.au' || host === 'bpl.link' || host.endsWith('.bpl.link')) return 60;
            return 480;
        }

        // ---------------------------------------------------------------------------------------------------------
        // Helpers
        // ---------------------------------------------------------------------------------------------------------
        // A node 2.4.3 could not even construct: red status, inputs acknowledged, nothing else.
        function deadNode(reason) {
            node.status({ fill: "red", shape: "ring", text: reason });
            healthLog('inert', `Uploader is not running: ${reason}`, true);
            node.on('input', function (msg, send, done) { if (done) done(); });
        }

        function configPayload() {
            return {
                "api_key": apiKeyConfig.api_key,
                "pool_name": pool_name,
                "api_endpoint_v2": node.rootUrlv2,
                "api_endpoint_v3": node.rootUrlv3,
                "upload_on_expired_secs": configuredInterval,
                "http_timeout_secs": configuredTimeout,
                "option_show_debug_warnings": bpChkShowDebugWarnings,
            };
        }

        function memoryOnlyFileCache() {
            return {
                lastError: Object.assign(new Error("memory-only cache"), { code: 'MEMORY_ONLY' }),
                setAside: [],
                getSize: () => 0,
                fileSize: () => -1,
                pendingSize: () => -1,
                isChunked: () => false,
                listStoredKeys: () => null,
                streamKeyExists: () => false,
                appendData: async () => false,
                readChunk: async () => ({ records: [], start: 0, end: 0, done: true, readOk: false }),
                commitChunk: async () => false,
                retrieveData: async () => [],
                purge: () => { },
                deleteFile: async () => true,
                heldFiles: () => [],
                restoreHeld: async () => 0,
            };
        }

        // A tracked timer. An error in its callback (or a rejected promise it returns) is logged, never left
        // uncaught: Node-RED exits on an uncaught exception.
        function schedule(fn, ms) {
            if (closed) return null;
            const t = setTimeout(() => {
                timers.delete(t);
                if (closed) return;
                try {
                    const result = fn();
                    if (result && typeof result.catch === 'function') {
                        result.catch(error => logError("Error in Timer:", error));
                    }
                } catch (error) {
                    logError("Error in Timer:", error);
                }
            }, Math.min(MAX_TIMER_MS, ms));
            timers.add(t);
            return t;
        }
        function delay(ms) {
            return new Promise(resolve => { if (!schedule(resolve, ms)) resolve(); });
        }
        function now() {
            return performance.now();
        }
        function jitter(ms) {
            return Math.round(ms * (1 - TIMING.retryJitter + Math.random() * 2 * TIMING.retryJitter));
        }
        function backoff(attempt) {
            return jitter(Math.min(TIMING.retryMaxMs, TIMING.retryMinMs * Math.pow(2, Math.max(0, attempt - 1))));
        }
        // Server dates arrive as "/Date(ms)/" (the API's default) or ISO text
        function parseServerDate(value) {
            if (value === null || value === undefined) return null;
            if (typeof value === 'number') return value;
            const m = /\/Date\((-?\d+)/.exec(String(value));
            if (m) return Number(m[1]);
            const t = Date.parse(value);
            return Number.isNaN(t) ? null : t;
        }
        // The server's LocalIndex match ignores case, accents and trailing spaces. foldWide may match a little more
        // than the server does (used where matching more is the safe side); foldNarrow matches only what it surely
        // does (case and trailing spaces).
        function foldWide(text) {
            return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ +$/, '');
        }
        function foldNarrow(text) {
            return String(text).toLowerCase().replace(/ +$/, '');
        }

        // 'unknown': the request may have reached the server (timeout, 504, reset). 'offline': it certainly
        // didn't. 'http': the server answered with an error.
        function classifyFailure(error) {
            if (error && error.response) {
                return error.response.status === 504 ? 'unknown' : 'http';
            }
            if (error && error.isProtocolError) {
                return 'http';
            }
            const code = String((error && error.code) || '');
            // Failures before the request could be sent: DNS, connect and TLS errors
            if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPROTO', 'ERR_NODE_CLOSED'].includes(code) ||
                /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)) {
                return 'offline';
            }
            return 'unknown';
        }

        // A request refused because the node had closed (see httpRequest)
        function isNodeClosed(error) {
            return !!(error && error.code === 'ERR_NODE_CLOSED');
        }

        function errorCode(error) {
            if (!error) return 'unknown error';
            if (error.response && error.response.status) return `HTTP ${error.response.status}`;
            return error.code || error.message || String(error);
        }

        function isHtml(res) {
            const type = (res && res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '';
            return /text\/html/i.test(String(type)) || (typeof (res && res.data) === 'string' && /^\s*</.test(res.data));
        }

        // A logs POST counts as accepted only if it is a 2xx with body OK (tolerant) or JSON, never HTML
        function isLogsAccepted(res) {
            if (!res || res.status < 200 || res.status > 299 || isHtml(res)) return false;
            if (typeof res.data === 'string') {
                return res.data.trim().replace(/^"|"$/g, '').toUpperCase() === 'OK';
            }
            return res.data !== null && typeof res.data === 'object';
        }

        function protocolError(res, message) {
            const error = new Error(message || `Unexpected response (HTTP ${res && res.status}${isHtml(res) ? ', HTML' : ''}): check the API endpoint`);
            error.code = 'EPROTOCOL';
            error.isProtocolError = true;
            return error;
        }

        function maskKey(key) {
            if (typeof key !== 'string' || key.length === 0) return key;
            return key.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-([0-9a-fA-F]{8})([0-9a-fA-F]{4})/, '********-****-****-****-********$2');
        }

        function redact(text) {
            let out = String(text);
            if (api_key) out = out.split(api_key).join(maskKey(api_key));
            return out.replace(/Bitpool2\s+[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, m => maskKey(m));
        }

        // Turns an error (axios or otherwise) into a short line. Never serialises config, request or sockets.
        function describe(value) {
            if (value === undefined || value === null) return '';
            if (typeof value === 'string') return value;
            if (value instanceof Error || value.message || value.code || value.response) {
                const parts = [];
                if (value.code) parts.push(value.code);
                if (value.response && value.response.status) parts.push(`HTTP ${value.response.status}`);
                if (value.message) parts.push(value.message);
                const data = value.response && value.response.data;
                if (data !== undefined && data !== null && data !== '') {
                    const text = typeof data === 'string' ? data : safeJson(data);
                    parts.push(`response: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`);
                }
                return parts.join(' ');
            }
            return safeJson(value);
        }
        function safeJson(value) {
            try {
                const text = JSON.stringify(value);
                return text === undefined ? String(value) : text;
            } catch (e) {
                return String(value);
            }
        }

        function updateStatusMsg(jsonProps) {
            node.status({ fill: jsonProps.fill, shape: jsonProps.shape, text: jsonProps.text });
        }
        function logError(param1, param2) {
            if (bpChkShowDebugWarnings) {
                if (param1) node.warn(redact(`ERROR: ${param1}`));
                if (param2) node.warn(redact(describe(param2)));
            }
        }
        function logWarn(param1, param2) {
            if (bpChkShowDebugWarnings) {
                if (param1) node.warn(redact(`WARNING: ${param1}`));
                if (param2) node.warn(redact(describe(param2)));
            }
        }
        function logInfo(param1) {
            if (bpChkShowDebugWarnings) {
                node.warn(redact(`INFO: ${param1}`))
            }
        }
        // Always-on health line: one per reason per minute, regardless of the debug option.
        // node.error without a msg only logs; Catch nodes fire only if the node opted in.
        function healthLog(reason, text, force) {
            const t = performance.now();
            if (!force && health.lastLogAt[reason] !== undefined && t - health.lastLogAt[reason] < TIMING.healthLogRepeatMs) return;
            health.lastLogAt[reason] = t;
            const line = redact(`Bitpool uploader: ${text}`);
            if (raiseFailuresToCatch) {
                // No msg.topic: a Catch node wired back into an uploader must not register a stream for it
                node.error(line, { payload: { reason, message: line } });
            } else {
                node.error(line);
            }
        }

        function cleanUserInput(input) {
            if (typeof input !== 'string') {
                return '';
            }
            // Remove non-printable characters, including control characters
            return input.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
        }
        function isValidApiKey(apiKey) {
            if (apiKey == null) { // Check for null or undefined
                return false;
            }
            const apiKeyRegex = /^Bitpool2 [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[4][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
            return apiKeyRegex.test(apiKey);
        }
        // The endpoint is used verbatim as https://<endpoint>/public/..., as in 2.4.3. Only an endpoint that can
        // never work is invalid: a scheme, whitespace, or a URL that doesn't parse. host:port, path prefixes, and
        // leading or trailing slashes (the URL parser and some proxies collapse them) are left alone.
        function isValidEndpoint(endpoint) {
            if (typeof endpoint !== 'string' || endpoint.length === 0 || /\s/.test(endpoint) || endpoint.includes('://')) {
                return false;
            }
            try {
                return new URL(`https://${endpoint}/public/v2/`).host.length > 0;
            } catch (error) {
                return false;
            }
        }
        function isValidPoolName(poolName) {
            // Check if poolName is not null, not undefined, not empty, not just numbers, and its length is <= 255
            return poolName != null && typeof poolName === 'string' && poolName.length > 0 && poolName.length <= 255 && !/^\d+$/.test(poolName);
        }
        function fixTags(tags) {
            // Fix tags format
            for (let i = 0; i < tags.length; i++) {
                // If tag start with not alpha, add 'a' to it
                if (!/^[a-zA-Z]/.test(tags[i])) {
                    tags[i] = 'a' + tags[i];
                }
                // convert tags to camelCase
                if (tags[i].includes("=")) {
                    const parts = tags[i].split("=").map(x => x.trim());
                    tags[i] = `${camelCase(parts[0])}=${parts[1]}`;
                } else {
                    tags[i] = camelCase(tags[i].trim());
                }
            }
            return tags;
        }
        function _removeNameSpacePrefix(tags) {
            for (let index = 0; index < tags.length; index++) {
                if (tags[index].includes(":")) {
                    const splitTag = tags[index].split(":")
                    tags[index] = splitTag[1];
                }
            };
            return tags;
        }
        function isValidGUID(str) {
            const guidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[4][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
            return guidRegex.test(str);
        }
        function isAnyGUID(str) {
            return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(str));
        }
        function cleanString(inputString) {
            // Remove unwanted backslashes and extra double quotes
            return inputString.replace(/["\\]/g, '');
        }
        function formatDateToDdHhMmSs(seconds) {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            const formattedHours = String(hours).padStart(2, '0');
            const formattedMinutes = String(minutes).padStart(2, '0');
            const formattedSeconds = String(secs).padStart(2, '0');

            if (days > 0) {
                return `${days} ${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
            } else {
                return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
            }
        }

        // Exposed for tests only
        this._internals = { counters, init, health, limiter, reg, queue, memoryPending, replay, runDrain, enqueueAll, flushKeys: () => flushKeys, closeAborts, dataRequests, bufferEvictions: () => node.pool.getEvictedCount() };
    };
    RED.nodes.registerType('uploader', BITPOOL);
}

module.exports.TIMING = TIMING;
