/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

const _ = require("underscore");
const camelCase = require('camelcase');
const fs = require('fs');
const path = require('path');

// If we have not worked out the data type, assume it is a double
const DataType = Object.freeze({
    DOUBLE: "Double",
    STRING: "String",
    UNKNOWN: "Double"
});

// Assume a stream reads every 5 mins
// (60/5)x24 = 288 readings per day
// 2000/288 = ~7days
const MAX_RECORDS_PER_STREAM = 2000;
const MAX_UNIQUE_TIMESTAMPS = 10;

class Data {
    constructor() {
        this.dataType = DataType.UNKNOWN;
        this.values = [];
        this.timestamps = new Set(); // Track existing timestamps        
    }
    addValue(value, recordDate) {
        // Round to the nearset second, remove timezone
        let timestamp = null;
        if (recordDate) {
            timestamp = recordDate.toISOString().split('.')[0] + 'Z';
        } else {
            timestamp = new Date().toISOString().split('.')[0] + 'Z';
        }

        if (typeof value === "boolean") {
            value = value.toString();
        }

        if (!this.timestamps.has(timestamp)) {
            // Add the new value. Readings stamped by the device clock (no recordDate) are flagged so they
            // can be dropped if the clock was clearly wrong while the cloud was unreachable (see dropDeviceReadingsBefore).
            this.values.push(recordDate ? { timestamp, value } : { timestamp, value, dev: true });
            this.timestamps.add(timestamp); // Add to the set

            // Ensure array does not exceed MAX_RECORDS_PER_STREAM - delete the oldest
            if (this.values.length > MAX_RECORDS_PER_STREAM) {
                this.values.shift();
                this.evicted = (this.evicted || 0) + 1;
            }

            // Keep a list of the last x inserted timestamps
            if (this.timestamps.size > MAX_UNIQUE_TIMESTAMPS) {
                const oldestTimestamp = Array.from(this.timestamps).shift();
                this.timestamps.delete(oldestTimestamp);
            }

            // Set dataType based on the first entry
            if (this.values.length === 1) {
                this.dataType = Data.checkDataType(value);
            }
        }
    }
    static checkDataType(value) {
        if (typeof value === "number") {
            return DataType.DOUBLE;
        } else if (typeof value === "string") {
            return DataType.STRING;
        } else if (typeof value === "boolean") {
            return DataType.STRING;
        } else {
            return DataType.UNKNOWN;
        }
    }
    getDataType() {
        return this.dataType;
    }
    setDataType(dataType) {
        this.dataType = dataType;
    }
    getAllValues() {
        const allValues = this.values.map(val => ({
            Ts: val.timestamp,
            Val: this.dataType === DataType.DOUBLE ? val.value : null,
            ValStr: this.dataType === DataType.STRING ? val.value : null,
            Calculated: false
        }));
        this.values = [];
        return allValues;
    }
    getSomeValues(count) {
        const someValues = this.values.slice(0, count).map(val => ({
            Ts: val.timestamp,
            Val: this.dataType === DataType.DOUBLE ? val.value : null,
            ValStr: this.dataType === DataType.STRING ? val.value : null,
            Calculated: false
        }));
        this.values = this.values.slice(count);
        return someValues;
    }
    delete() {
        this.values = [];
    }
    // Drops device-clock readings stamped before cutoffMs. Returns the number dropped.
    dropDeviceReadingsBefore(cutoffMs) {
        const before = this.values.length;
        this.values = this.values.filter(v => !(v.dev && Date.parse(v.timestamp) < cutoffMs));
        return before - this.values.length;
    }
    static fromJSON(json) {
        const data = new Data();
        data.dataType = json.dataType;
        data.values = json.values;
        return data;
    }
    toJSON() {
        return {
            dataType: this.dataType,
            values: this.values
        };
    }
}

class Stream {
    constructor(streamName = "", streamKey = "", streamTags = []) {
        this.streamName = streamName;
        this.streamKey = streamKey;
        this.streamTags = streamTags;
        this.areTagsPosted = false;
        this.data = new Data();
    }
    addData(value, recordDate) {
        this.data.addValue(value, recordDate);
        return this.streamKey, this.areTagsPosted
    }
    getData() {
        return this.data;
    }
    setTagsPosted(posted) {
        this.areTagsPosted = posted;
    }
    getTagsPosted() {
        return this.areTagsPosted;
    }
    getStreamKey() {
        return this.streamKey || null;
    }
    getStreamName() {
        return this.streamName || null;
    }
    updateTags(tags) {
        this.streamTags = tags;
    }
    getStreamTags() {
        return this.streamTags;
    }
    getDataType() {
        return this.data.getDataType();
    }
    setDataType(dataType) {
        this.data.setDataType(dataType);
    }
    getAllValues() {
        return this.data.getAllValues();
    }
    getSomeValues(count) {
        return this.data.getSomeValues(count);
    }
    getRecordCount() {
        return this.data.values.length || 0;
    }
    static fromJSON(json) {
        const stream = new Stream();
        stream.streamName = json.streamName;
        stream.streamKey = json.streamKey;
        stream.dataType = json.dataType;
        stream.streamTags = json.streamTags;
        return stream;
    }
    toJSON() {
        return {
            streamName: this.streamName,
            streamKey: this.streamKey,
            dataType: this.dataType,
            streamTags: this.streamTags,
        };
    }
}

class Streams {
    constructor() {
        this.streams = new Map();
        this.nameToKey = new Map();
        this.keyToName = new Map();
        this.countOfAllRecs = 0;
    }
    addStreamName(streamName) {
        if (!streamName) {
            throw new Error("Stream name cannot be empty");
        }
        if (this.streams.has(streamName) == false) {
            this.streams.set(streamName, new Stream(streamName));
        }
        return this.streams.get(streamName);
    }
    updateStreamKey(streamName, streamKey = null) {
        if (!streamName) {
            throw new Error("Stream name cannot be empty");
        }
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.streamKey = streamKey;
            this.nameToKey.set(streamName, streamKey);
            if (streamKey) {
                this.keyToName.set(streamKey, streamName);
            }
        }
    }
    // Gives a name a key without making it the name the key's readings are taken from (keyToName)
    mapNameOnly(streamName, streamKey) {
        if (this.streams.has(streamName)) {
            this.streams.get(streamName).streamKey = streamKey;
            this.nameToKey.set(streamName, streamKey);
        }
    }
    hasStreamKey(streamKey) {
        return this.keyToName.has(streamKey);
    }
    hasStreamName(streamName) {
        return this.nameToKey.has(streamName);
    }

    setDataType(streamName, dataType) {
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.dataType = dataType;
        }
    }
    getDataType(streamName) {
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            return existingStream.dataType;
        }
        return null;
    }

    getCountOfAllRecords() {
        let totalRecords = 0;
        this.streams.forEach(stream => {
            totalRecords += stream.getRecordCount();
        });
        this.countOfAllRecs = totalRecords;
        return totalRecords;
    }
    getStreamByNameOrKey(identifier) {
        if (!identifier) {
            throw new Error("Stream name/key cannot be empty");
        }

        const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(identifier);

        if (isGuid) {
            const streamName = this.keyToName.get(identifier);
            return streamName ? this.streams.get(streamName) : null;
        } else {
            return this.streams.get(identifier) || null;
        }
    }
    getStreamKeyList() {
        return Array.from(this.nameToKey.values());
    }
    getStreamKeyCount() {
        return this.keyToName.size;
    }
    getStreamCount() {
        return this.streams.size;
    }
    getStreamNameByKey(streamGuid) {
        return this.keyToName.get(streamGuid) || null;
    }
    purgeRecordsOnly() {
        this.streams.forEach(stream => {
            stream.data.values = [];
        });
        this.countOfAllRecs = 0
    }
    dropDeviceReadingsBefore(cutoffMs, onlyUnkeyed) {
        let dropped = 0;
        this.streams.forEach(stream => {
            if (onlyUnkeyed && stream.getStreamKey()) return;
            dropped += stream.data.dropDeviceReadingsBefore(cutoffMs);
        });
        return dropped;
    }
    // Readings dropped because a stream's buffer reached MAX_RECORDS_PER_STREAM
    getEvictedCount() {
        let evicted = 0;
        this.streams.forEach(stream => {
            evicted += stream.data.evicted || 0;
        });
        return evicted;
    }
    updateStreamTags(streamName, tags) {
        if (!streamName || !tags) {
            throw new Error("Stream name and tags cannot be empty");
        }
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.streamTags = tags;
        } else {
            throw new Error("Stream not found");
        }
    }
    delete(streamName) {
        this.streams.delete(streamName);
    }
    deleteValues(streamName) {
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.data.values = []
        }
    }
    static fromJSON(json) {
        const streams = new Streams();
        streams.nameToKey = new Map(json.nameToKey);
        streams.keyToName = new Map(json.keyToName);
        streams.streams = new Map(Object.entries(json.streams).map(([key, value]) => [key, Stream.fromJSON(value)]));
        return streams;
    }

    toJSON() {
        const streamsObj = {};
        this.streams.forEach((value, key) => {
            streamsObj[key] = value.toJSON();
        });
        return {
            nameToKey: Array.from(this.nameToKey.entries()),
            keyToName: Array.from(this.keyToName.entries()),
            streams: streamsObj,
        };
    }
}

class Pool {
    constructor() {
        this.poolName = "";
        this.poolKey = "";
        this.stationId = "";
        this.poolTags = [];
        this.streams = new Streams();
    }
    setPoolName(poolName) {
        this.poolName = poolName;
    }
    getPoolName() {
        return this.poolName || null;
    }
    setPoolKey(poolKey) {
        this.poolKey = poolKey;
    }
    getPoolKey() {
        return this.poolKey || null;
    }
    setStationId(stationId) {
        this.stationId = stationId;
    }
    getStationId() {
        return this.stationId || null;
    }
    setPoolTags(poolTags) {
        if (Array.isArray(poolTags)) {
            this.poolTags = poolTags.map(tag => tag.trim());
        } else {
            throw new Error("Invalid input: poolTags must be a string or an array");
        }
    }
    hasStreamKey(streamKey) {
        return this.streams.hasStreamKey(streamKey);
    }
    hasStreamName(streamName) {
        return this.streams.hasStreamName(streamName);
    }

    getStreamCount() {
        return this.streams.getStreamCount();
    }
    getStreamKeyCount() {
        return this.streams.getStreamKeyCount();
    }
    getCountOfAllRecords() {
        return this.streams.getCountOfAllRecords();
    }
    getStreamNameByKey(streamGuid) {
        return this.streams.getStreamNameByKey(streamGuid);
    }
    createTagListFromString(tags) {
        return tags ? tags.split(/\s*,\s*/) : [];
    }
    purgeRecordsOnly() {
        this.streams.purgeRecordsOnly();
    }
    dropDeviceReadingsBefore(cutoffMs, onlyUnkeyed) {
        return this.streams.dropDeviceReadingsBefore(cutoffMs, onlyUnkeyed);
    }
    getEvictedCount() {
        return this.streams.getEvictedCount();
    }
    cleanTags(tagStr) {
        const cleanedTagList = tagStr.split(',');
        return cleanedTagList.map(item => {
            const equalIndex = item.indexOf('=');
            if (equalIndex !== -1) {
                const keyValue = item.substring(0, equalIndex).split(':').pop();
                const value = item.substring(equalIndex + 1).trim();
                return `${camelCase(keyValue.trim())}=${value}`;
            }
            return item;
        });
    }
    findMissingTags(nodePoolTags, serverPoolTags) {
        const missingTags = nodePoolTags.filter(tag => !serverPoolTags.includes(tag));
        return missingTags.length > 0 ? missingTags : [];
    }
    addStreamName(streamName) {
        return this.streams.addStreamName(streamName);
    }
    updateStreamKey(streamName, streamKey = null) {
        this.streams.updateStreamKey(streamName, streamKey);
    }
    mapNameOnly(streamName, streamKey) {
        this.streams.mapNameOnly(streamName, streamKey);
    }
    getStreamByNameOrKey(identifier) {
        return this.streams.getStreamByNameOrKey(identifier);
    }
    getStreamKeyList() {
        return this.streams.getStreamKeyList();
    }
    updateStreamTags(streamName, tags) {
        this.streams.updateStreamTags(streamName, tags);
    }
    setDataType(streamName, dataType) {
        this.streams.setDataType(streamName, dataType);
    }
    getDataType(streamName) {
        return this.streams.getDataType(streamName);
    }
    deleteStream(streamName) {
        this.streams.delete(streamName);
    }
    deleteStreamValues(streamName) {
        this.streams.deleteValues(streamName);
    }
    stream(streamName) {
        const stream = this.streams.getStreamByNameOrKey(streamName);
        if (!stream) {
            throw new Error("Stream not found");
        }
        return stream;
    }
    static fromJSON(json) {
        const pool = new Pool();
        pool.poolName = json.poolName;
        pool.poolKey = json.poolKey;
        pool.stationId = json.stationId;
        pool.poolTags = json.poolTags;
        pool.streams = Streams.fromJSON(json.streams);
        return pool;
    }
    toJSON() {
        return {
            poolName: this.poolName,
            poolKey: this.poolKey,
            stationId: this.stationId,
            poolTags: this.poolTags,
            streams: this.streams.toJSON()
        };
    }
}


// Worked example if data store in numeric (8b) with timestamp (8b)
// where; 1 record = 16 bytes. Max file size 30K bytes
//      => 30Kb/16b = 1920 records  
//      => 1920 recs / 12 / 60 = 160hrs (or 7 days) at 5 minute logging

const MAX_FILE_SIZE_BYTES = 30 * 1024;                       // 30 KB (in bytes)
const MAX_FILE_AGE_MILLI_SECS = 30 * 24 * 60 * 60 * 1000;    // 30 days (in milliseconds)

// Folders inside the cache folder. 2.4.3 and 2.4.4 only read ./bitpool-data/*.bin, so after a rollback they leave
// these alone (they neither send nor delete them).
const REPLAY_DIR = 'replay';     // caches that grew past 30 KB (2.4.3's start deleted those); sent in chunks
const HOLD_DIR = 'hold';         // files 2.4.3 would have deleted at start-up: kept, sent only on REPLAY_HELD
const SPOOL_DIR = 'spool';       // upload cycles that were waiting at close, as the requests they would have been
// Growth past what 2.4.3 kept (a cache past 30 KB) pauses while free disk space is below the smaller of these
const MIN_FREE_BYTES = 100 * 1024 * 1024;
const MIN_FREE_FRACTION = 0.02;
const DISK_CHECK_MS = 30000;
// A record restored from the spool can carry its 2.4.3 cache encoding (see Spool); encodeRecord writes it as is
const LEGACY_BYTES = Symbol('legacyBytes');
// 2.4.3 could send a cache in one request up to about this many records (its push(...) overflowed beyond)
const LEGACY_MAX_RECORDS = 124000;
// The cloud's dates run from year 0001 to 9999; a record outside them gets the whole request rejected
const MIN_SERVER_DATE_MS = -62135596800000;
const MAX_SERVER_DATE_MS = 253402300800000;

class FileStorageCache {

    constructor(storagePath) {
        this.streamKeyPath = new Map();
        this.storagePath = path.resolve(storagePath);       // the working directory at start, as for 2.4.3
        this.replayPath = path.join(this.storagePath, REPLAY_DIR);
        this.holdPath = path.join(this.storagePath, HOLD_DIR);
        this.setAside = [];                      // files this start set aside: { key, file, bytes, reason }
        this.blockedMain = new Set();            // keys whose main-folder file had to be set aside but couldn't move
        this.positions = new Map();              // key -> { pos, head }: accepted bytes of its replay/ file (also on disk)
        this.checked = new Map();                // key -> { records } once its replay/ file's end was checked
        this.disk = { checkedAt: -Infinity, low: false };
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
        }
        this.loadFiles();
    }
    // Start-up. 2.4.3 deleted every cache file over 30 KB or older than 30 days here; nothing is deleted now.
    // - Such a file in the main folder was written by an earlier version (this one moves a cache to replay/ before
    //   it passes 30 KB), and 2.4.3 would have deleted it at this start. It is set aside in hold/: kept, but sent
    //   only on REPLAY_HELD, because data may have been backfilled since.
    // - Caches in replay/ are kept whatever their size or age.
    // It runs synchronously, so no upload can read a file before it has been sorted.
    loadFiles() {
        const now = Date.now();
        let files = [];
        try {
            files = fs.readdirSync(this.storagePath);
        } catch (e) { }
        for (const file of files) {
            if (!file.endsWith('.bin')) continue;
            const streamKey = path.basename(file, '.bin');
            const filePath = path.join(this.storagePath, file);
            try {
                const stats = fs.statSync(filePath);
                if (!stats.isFile()) continue;
                const tooBig = stats.size > MAX_FILE_SIZE_BYTES;
                if (tooBig || now - stats.mtimeMs > MAX_FILE_AGE_MILLI_SECS) {
                    this.setAsideFile(streamKey, filePath, stats.size, tooBig ? 'over 30 KB' : 'older than 30 days', now);
                } else {
                    this.streamKeyPath.set(streamKey, filePath);
                }
            } catch (e) { }
        }
        let replayFiles = [];
        try {
            replayFiles = fs.readdirSync(this.replayPath);
        } catch (e) { }
        for (const file of replayFiles) {
            if (!file.endsWith('.bin')) continue;
            const streamKey = path.basename(file, '.bin');
            const filePath = path.join(this.replayPath, file);
            try {
                if (!fs.statSync(filePath).isFile()) continue;
                const legacy = this.streamKeyPath.get(streamKey);
                if (legacy) {
                    // An earlier version wrote to the main folder meanwhile (a rollback): those records are newer.
                    // A record cut off at the end of the replay/ file would swallow them, so it goes first.
                    const end = FileStorageCache.scanSync(filePath).end;
                    if (end < fs.statSync(filePath).size) fs.truncateSync(filePath, end);
                    fs.appendFileSync(filePath, fs.readFileSync(legacy));
                    fs.unlinkSync(legacy);
                }
                this.streamKeyPath.set(streamKey, filePath);
            } catch (e) { }
        }
    }
    setAsideFile(streamKey, filePath, bytes, reason, now) {
        try {
            fs.mkdirSync(this.holdPath, { recursive: true });
            const target = path.join(this.holdPath, `${streamKey}.${now}.bin`);
            fs.renameSync(filePath, target);
            this.setAside.push({ key: streamKey, file: target, bytes, reason });
        } catch (e) {
            // It stays where it is but isn't used: the stream's cache goes to replay/ instead
            this.blockedMain.add(streamKey);
            this.setAside.push({ key: streamKey, file: filePath, bytes, reason: `${reason}; could not be moved (${e.code || e.message}), left in place` });
        }
    }

    getSize() {
        return this.streamKeyPath.size;
    }
    // Where a stream's cache is: in the main folder while it is within 30 KB (where 2.4.3 reads it after a
    // rollback), in replay/ once it has grown past that
    pathFor(streamKey) {
        const replayFile = path.join(this.replayPath, `${streamKey}.bin`);
        if (this.blockedMain.has(streamKey)) return replayFile;
        return fs.existsSync(replayFile) ? replayFile : path.join(this.storagePath, `${streamKey}.bin`);
    }
    isReplayFile(filePath) {
        return path.dirname(filePath) === this.replayPath;
    }
    // Whether the stream's cache is sent in chunks (a replay/ file) rather than whole, as 2.4.3 sends it
    isChunked(streamKey) {
        return this.isReplayFile(this.pathFor(streamKey));
    }
    posPath(streamKey) {
        return path.join(this.replayPath, `${streamKey}.pos`);
    }
    sentPath(streamKey) {
        return path.join(this.replayPath, `${streamKey}.sent`);
    }
    // How many bytes at the start of a replay/ file the cloud has accepted (see commitChunk). The .pos file names the
    // file's first bytes, so it never applies to another file with the same name.
    readPos(streamKey, size) {
        const current = this.head(streamKey);
        const known = this.positions.get(streamKey);
        let pos = known && known.head === current ? known.pos : 0;
        try {
            const [text, head] = fs.readFileSync(this.posPath(streamKey), 'utf8').split(' ');
            const saved = Number(text);
            if (Number.isInteger(saved) && saved > pos && head === current) pos = saved;
        } catch (e) { }
        return pos > 0 && pos <= size ? pos : 0;
    }
    head(streamKey) {
        let fd = null;
        try {
            fd = fs.openSync(path.join(this.replayPath, `${streamKey}.bin`), 'r');
            const buffer = Buffer.alloc(16);
            const n = fs.readSync(fd, buffer, 0, 16, 0);
            return buffer.subarray(0, n).toString('hex');
        } catch (e) {
            return '';
        } finally {
            if (fd !== null) fs.closeSync(fd);
        }
    }
    // A new replay/ file starts with nothing sent
    resetProgress(streamKey) {
        this.positions.delete(streamKey);
        this.checked.delete(streamKey);
        for (const file of [this.posPath(streamKey), this.sentPath(streamKey)]) {
            try {
                fs.unlinkSync(file);
            } catch (e) { }
        }
    }
    // Size in bytes of a stream's cache file, or -1 if it has none
    fileSize(streamKey) {
        try {
            return fs.statSync(this.pathFor(streamKey)).size;
        } catch (e) {
            return -1;
        }
    }
    // Bytes of a stream's cache not sent yet, or -1 if it has none
    pendingSize(streamKey) {
        const filePath = this.pathFor(streamKey);
        try {
            const size = fs.statSync(filePath).size;
            return this.isReplayFile(filePath) ? size - this.readPos(streamKey, size) : size;
        } catch (e) {
            return -1;
        }
    }
    listStoredKeys() {
        if (this.streamKeyPath.size === 0) {
            return null;
        }
        return this.streamKeyPath;
    }
    // A replay/ file's end is checked once per run: a record cut off by a crash or a full disk would swallow the
    // records appended after it, so it is cut away (2.4.3 never read past it either). Records the file holds are
    // counted. Call with the stream's cache lock held.
    async checkEnd(streamKey) {
        const filePath = path.join(this.replayPath, `${streamKey}.bin`);
        if (this.checked.has(streamKey) || !fs.existsSync(filePath)) return;
        const scan = await FileStorageCache.scan(filePath);
        if (scan.end < scan.size) await fs.promises.truncate(filePath, scan.end);
        this.checked.set(streamKey, { records: scan.records });
    }
    // Appends records to the stream's cache file. Never throws: an I/O failure (disk full, read-only
    // filesystem, missing folder, too many open files) returns false and leaves the error in lastError.
    // In 2.4.3 the same failures were an unhandled WriteStream 'error' event, which exited Node-RED.
    async appendData(streamKey, dataArray) {
        const records = [];
        for (const data of dataArray) {
            const record = FileStorageCache.encodeRecord(data);
            if (record) {
                records.push(record);
            }
        }
        const bytes = Buffer.concat(records);
        let filePath = null;
        let sizeBefore = -1;                     // the file's size before this append; -1 if unknown (then not undone)
        try {
            // Even with nothing encodable the file is created, as 2.4.3 did (it counts towards Cached:(n))
            await fs.promises.mkdir(this.storagePath, { recursive: true });
            filePath = this.pathFor(streamKey);
            sizeBefore = await FileStorageCache.sizeOf(filePath);
            if (!this.isReplayFile(filePath) && Math.max(0, sizeBefore) + bytes.length > MAX_FILE_SIZE_BYTES) {
                // Past 30 KB the cache moves to replay/, where no start (of this or an earlier version) deletes it
                this.checkDisk();
                await fs.promises.mkdir(this.replayPath, { recursive: true });
                const target = path.join(this.replayPath, `${streamKey}.bin`);
                this.resetProgress(streamKey);
                if (sizeBefore > 0) {
                    await fs.promises.rename(filePath, target);
                }
                filePath = target;
            }
            if (this.isReplayFile(filePath)) {
                await fs.promises.mkdir(this.replayPath, { recursive: true });
                await this.checkEnd(streamKey);
                sizeBefore = await FileStorageCache.sizeOf(filePath);
                if (Math.max(0, sizeBefore) + bytes.length > MAX_FILE_SIZE_BYTES) this.checkDisk();
            }
            await fs.promises.appendFile(filePath, bytes);
            const checked = this.checked.get(streamKey);
            if (checked) checked.records += records.length;
            this.streamKeyPath.set(streamKey, filePath);
            this.lastError = null;
            return true;
        } catch (e) {
            // A partly written record would corrupt the records appended after it
            if (filePath && sizeBefore >= 0) {
                await fs.promises.truncate(filePath, sizeBefore).catch(() => { });
            }
            this.lastError = e;
            return false;
        }
    }
    // A file's size: 0 if it doesn't exist, -1 if it can't be told
    static async sizeOf(file) {
        try {
            return (await fs.promises.stat(file)).size;
        } catch (e) {
            return e.code === 'ENOENT' ? 0 : -1;
        }
    }
    // Throws while free disk space is below min(100 MB, 2% of the disk), so a cache can't fill the disk. Only growth
    // past what 2.4.3 kept (a cache past 30 KB) is checked. Without fs.statfs (Node before 18.15) there is no check,
    // as in 2.4.3.
    checkDisk() {
        if (typeof fs.statfsSync !== 'function') return;
        const t = Date.now();
        if (t - this.disk.checkedAt >= DISK_CHECK_MS) {
            this.disk.checkedAt = t;
            try {
                const s = fs.statfsSync(this.storagePath);
                const total = Number(s.blocks) * Number(s.bsize);
                const free = Number(s.bavail) * Number(s.bsize);
                this.disk.low = total > 0 && free < Math.min(MIN_FREE_BYTES, total * MIN_FREE_FRACTION);
            } catch (e) {
                this.disk.low = false;
            }
        }
        if (this.disk.low) {
            throw Object.assign(new Error('free disk space is low, so a cache past 30 KB stops growing'), { code: 'ECACHEDISKLOW' });
        }
    }

    // Encodes one record in the 2.4.3 cache format: type byte, timestamp, then value.
    // Every record 2.4.3 wrote successfully is encoded byte-identically. Values 2.4.3 could not encode
    // (which tore the file and corrupted every later record) are written as text if they are finite
    // numbers and otherwise skipped. Text is cut at its first NUL, which is exactly what 2.4.3 reads back.
    static encodeRecord(data) {
        if (data && Object.prototype.hasOwnProperty.call(data, LEGACY_BYTES)) {
            return data[LEGACY_BYTES];
        }
        try {
            if (data.Val !== null && data.Val !== undefined) {
                // Type byte (0=double) + timestamp + value (17 bytes)
                const buffer = Buffer.allocUnsafe(17);
                buffer.writeUInt8(0, 0);
                buffer.writeDoubleBE(new Date(data.Ts).getTime(), 1);
                buffer.writeDoubleBE(data.Val, 9);
                return buffer;
            } else if (data.ValStr !== null && data.ValStr !== undefined) {
                // Type byte (1=string) + timestamp + string + null terminator
                let text;
                try {
                    text = Buffer.from(data.ValStr, 'utf8');
                } catch (e) {
                    if (typeof data.ValStr !== 'number' || !Number.isFinite(data.ValStr)) {
                        return null;
                    }
                    text = Buffer.from(String(data.ValStr), 'utf8');
                }
                const nul = text.indexOf(0);
                if (nul !== -1) {
                    text = text.subarray(0, nul);
                }
                const timestampBuffer = Buffer.allocUnsafe(8);
                timestampBuffer.writeDoubleBE(new Date(data.Ts).getTime(), 0);
                return Buffer.concat([Buffer.from([1]), timestampBuffer, text, Buffer.from([0])]);
            }
        } catch (e) { }
        return null;
    }
    // Whether the cloud can take a record's date at all: a date outside years 0001-9999 (a timestamp given in
    // milliseconds, for example) gets the whole request rejected, every time
    static serverDate(record) {
        const t = Date.parse(record.Ts);
        return t >= MIN_SERVER_DATE_MS && t < MAX_SERVER_DATE_MS;
    }
    // 2.4.3's decoder (its retrieveData loop): type byte, 8-byte timestamp, then an 8-byte double (type 0) or
    // NUL-terminated text (type 1). An unknown type byte skips just the 9-byte header, a record whose timestamp
    // makes no date is skipped, and a record cut off at the end of the file stops it.
    // data is the file from a record boundary, and reaches the end of the file if atEnd. Decodes up to max records,
    // and stops before a record that starts maxBytes or more into data. Returns { records, consumed, exhausted,
    // needMore }: exhausted when no complete record is left, needMore when data stops before the end of the file
    // with fewer than max records decoded.
    static decode(data, max, atEnd, maxBytes) {
        const records = [];
        const limit = maxBytes || Infinity;
        let offset = 0;
        while (offset < data.length) {
            if (records.length >= max || (records.length > 0 && offset >= limit)) {
                return { records, consumed: offset, exhausted: false, needMore: false };
            }
            const start = offset;
            const recordType = data.readUInt8(offset);
            offset += 1;
            if (offset + 8 > data.length) return FileStorageCache.stopAt(records, start, atEnd);
            const timestamp = data.readDoubleBE(offset);
            offset += 8;
            let dataString = null;
            let dataNumber = null;
            if (recordType === 0) {
                if (offset + 8 > data.length) return FileStorageCache.stopAt(records, start, atEnd);
                dataNumber = data.readDoubleBE(offset);
                offset += 8;
            } else if (recordType === 1) {
                const nullIndex = data.indexOf(0, offset);
                if (nullIndex === -1) return FileStorageCache.stopAt(records, start, atEnd);
                dataString = data.subarray(offset, nullIndex).toString('utf8');
                offset = nullIndex + 1;
            } else {
                continue;
            }
            try {
                records.push({
                    Ts: new Date(timestamp).toISOString(),
                    Val: recordType === 0 ? dataNumber : null,
                    ValStr: recordType === 1 ? dataString : null,
                    Calculated: false
                });
            } catch (e) { }
        }
        return { records, consumed: offset, exhausted: atEnd, needMore: !atEnd && records.length < max && offset < limit };
    }
    // A record runs past data: at the end of the file that is 2.4.3's stop at a cut-off record
    static stopAt(records, start, atEnd) {
        return { records, consumed: start, exhausted: atEnd, needMore: !atEnd };
    }
    // Walks records the way decode does, without decoding them, counting them in out.records. Returns where the last
    // complete record in data ends (the end of data, unless its last record is cut off).
    static walk(data, out) {
        let offset = 0;
        while (offset < data.length) {
            const start = offset;
            const recordType = data[offset];
            offset += 9;
            if (offset > data.length) return start;
            if (recordType === 0) {
                offset += 8;
                if (offset > data.length) return start;
            } else if (recordType === 1) {
                const nullIndex = data.indexOf(0, offset);
                if (nullIndex === -1) return start;
                offset = nullIndex + 1;
            } else {
                continue;
            }
            out.records++;
        }
        return offset;
    }
    static scanSync(file) {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const out = { records: 0 };
            let position = 0;
            let length = 1024 * 1024;
            while (position < size) {
                const data = Buffer.alloc(Math.min(length, size - position));
                const bytesRead = fs.readSync(fd, data, 0, data.length, position);
                const atEnd = position + bytesRead >= size;
                const records = out.records;
                const end = FileStorageCache.walk(data.subarray(0, bytesRead), out);
                if (end === 0 && !atEnd) {
                    out.records = records;
                    length *= 2;                       // one record bigger than the read
                    continue;
                }
                position += end;
                if (atEnd || end === 0) break;
            }
            return { size, end: position, records: out.records };
        } finally {
            fs.closeSync(fd);
        }
    }
    static async scan(file) {
        const input = await fs.promises.open(file, 'r');
        try {
            const size = (await input.stat()).size;
            const out = { records: 0 };
            let position = 0;
            let length = 1024 * 1024;
            while (position < size) {
                const data = Buffer.alloc(Math.min(length, size - position));
                const { bytesRead } = await input.read(data, 0, data.length, position);
                const atEnd = position + bytesRead >= size;
                const records = out.records;
                const end = FileStorageCache.walk(data.subarray(0, bytesRead), out);
                if (end === 0 && !atEnd) {
                    out.records = records;
                    length *= 2;                       // one record bigger than the read
                    continue;
                }
                position += end;
                if (atEnd || end === 0) break;
            }
            return { size, end: position, records: out.records };
        } finally {
            await input.close();
        }
    }
    // Reads up to max records (and about maxBytes of file) of a stream's cache, decoded exactly as 2.4.3 decodes the
    // whole file: from the start, or for a replay/ file from where its last accepted chunk ended. Returns
    // { records, start, end, done, readOk }: the next chunk starts at end; done when no complete record is left.
    async readChunk(streamKey, max, maxBytes) {
        const filePath = this.pathFor(streamKey);
        const chunk = { records: [], start: 0, end: 0, done: false, readOk: false, head: null };
        let fileHandle = null;
        try {
            if (this.isReplayFile(filePath)) {
                await this.checkEnd(streamKey);
                chunk.head = this.head(streamKey);
            }
            fileHandle = await fs.promises.open(filePath, 'r');
            const size = (await fileHandle.stat()).size;
            const start = this.isReplayFile(filePath) ? this.readPos(streamKey, size) : 0;
            chunk.start = start;
            chunk.end = start;
            let length = max === Infinity ? size - start : Math.min(size - start, Math.max(65536, max * 32));
            if (maxBytes) length = Math.min(length, Math.max(65536, maxBytes + 65536));
            for (; ;) {
                const data = Buffer.alloc(length);
                const { bytesRead } = await fileHandle.read(data, 0, length, start);
                const out = FileStorageCache.decode(data.subarray(0, bytesRead), max, start + bytesRead >= size, maxBytes);
                if (out.needMore && length < size - start) {
                    length = Math.min(size - start, length * 2);
                    continue;
                }
                chunk.records = out.records;
                chunk.end = start + out.consumed;
                chunk.done = out.exhausted;
                break;
            }
            chunk.readOk = true;
        } catch (e) {
            this.lastError = e;
        } finally {
            if (fileHandle !== null) {
                await fileHandle.close().catch(() => { });
            }
        }
        return chunk;
    }
    // The cloud accepted everything in a replay/ file before end. Kept in memory, and on disk for the next run
    // (written atomically); returns false if the disk write failed. head: the file's head when the chunk was read
    // (a file rewritten since is left alone).
    async commitChunk(streamKey, end, head) {
        if (head === undefined || head === null) head = this.head(streamKey);
        if (head !== this.head(streamKey)) return true;
        this.positions.set(streamKey, { pos: end, head });
        const file = this.posPath(streamKey);
        try {
            await fs.promises.writeFile(`${file}.tmp`, `${end} ${head}`);
            await fs.promises.rename(`${file}.tmp`, file);
            return true;
        } catch (e) {
            this.lastError = e;
            return false;
        }
    }
    // Whether a replay/ file is small enough that 2.4.3 could have sent it in one request: only then do its chunks
    // need to store exactly what that request would have (see the uploader's chunkRecords)
    dedupeApplies(streamKey) {
        const checked = this.checked.get(streamKey);
        return !!checked && checked.records <= LEGACY_MAX_RECORDS;
    }
    // Readings already sent from a replay/ file, kept next to it: a 32-byte header naming the file's first bytes (so
    // it never applies to another file with the same name), then 8 bytes per reading. See the uploader's chunkRecords.
    sentHeader(streamKey) {
        const header = Buffer.alloc(32);
        Buffer.from(this.head(streamKey), 'hex').copy(header);
        return header;
    }
    async readSent(streamKey) {
        const sent = new Set();
        try {
            const data = await fs.promises.readFile(this.sentPath(streamKey));
            if (data.length < 32 || !data.subarray(0, 32).equals(this.sentHeader(streamKey))) return sent;
            for (let offset = 32; offset + 8 <= data.length; offset += 8) sent.add(data.readDoubleBE(offset));
        } catch (e) { }
        return sent;
    }
    async addSent(streamKey, keys) {
        if (keys.length === 0) return;
        const data = Buffer.alloc(keys.length * 8);
        keys.forEach((k, i) => data.writeDoubleBE(k, i * 8));
        const file = this.sentPath(streamKey);
        const header = this.sentHeader(streamKey);
        try {
            let current = null;
            try {
                const fd = await fs.promises.open(file, 'r');
                try {
                    const buffer = Buffer.alloc(32);
                    const { bytesRead } = await fd.read(buffer, 0, 32, 0);
                    current = buffer.subarray(0, bytesRead);
                } finally {
                    await fd.close();
                }
            } catch (e) { }
            if (current && current.equals(header)) {
                await fs.promises.appendFile(file, data);
            } else {
                await fs.promises.writeFile(file, Buffer.concat([header, data]));
            }
        } catch (e) {
            this.lastError = e;
        }
    }
    // The whole cache not sent yet. The returned array has a non-enumerable readOk: true when the file was read
    // (even if it held no record).
    async retrieveData(streamKey, dataType) {
        const chunk = await this.readChunk(streamKey, Infinity);
        const dataEntries = chunk.records;
        Object.defineProperty(dataEntries, 'readOk', { value: chunk.readOk });
        return dataEntries;
    }

    streamKeyExists(streamKey) {
        const filePath = this.pathFor(streamKey);
        if (fs.existsSync(filePath)) {
            this.streamKeyPath.set(streamKey, filePath);
            return true;
        }
        // As 2.4.3: a file deleted from outside keeps its entry (and its Cached:(n) count) until the next start
        return false;
    }
    purge() {
        try {
            this.streamKeyPath.forEach((value, key) => {
                this.deleteFile(key);
            });
        } catch (e) { }
    }

    // Waits for the unlink to finish (2.4.3 returned before it ran, so an append right after could be lost).
    async deleteFile(streamKey) {
        try {
            const filePath = this.pathFor(streamKey);
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
            if (this.isReplayFile(filePath)) {
                this.resetProgress(streamKey);
            }
            this.streamKeyPath.delete(streamKey);
        } catch (e) {
            return false
        }
        return true;
    }

    // Files set aside in hold/ (at this or an earlier start): [{ key, file, bytes }]
    heldFiles() {
        let names = [];
        try {
            names = fs.readdirSync(this.holdPath);
        } catch (e) {
            return [];
        }
        return names.filter(name => /^[0-9a-fA-F-]{36}\.\d+\.bin$/.test(name)).sort().map(name => {
            const file = path.join(this.holdPath, name);
            let bytes = 0;
            try {
                bytes = fs.statSync(file).size;
            } catch (e) { }
            return { key: name.slice(0, 36), file, bytes };
        });
    }
    // Puts a stream's set-aside files back, with what is left of its cache, as one replay/ file. Each part keeps its
    // own order; the parts go oldest first (by their first reading). Their records are decoded as 2.4.3 decodes each
    // file and written again, so a record cut off at the end of one part can't run into the next. Returns the number
    // of files restored. Call with the stream's cache lock held.
    async restoreHeld(streamKey) {
        const held = this.heldFiles().filter(h => h.key === streamKey);
        if (held.length === 0) return 0;
        await fs.promises.mkdir(this.replayPath, { recursive: true });
        const target = path.join(this.replayPath, `${streamKey}.bin`);
        const tmp = `${target}.tmp`;
        const current = this.pathFor(streamKey);
        const parts = held.map(h => ({ file: h.file, from: 0 }));
        try {
            const size = fs.statSync(current).size;
            parts.push({ file: current, from: this.isReplayFile(current) ? this.readPos(streamKey, size) : 0, current: true });
        } catch (e) { }
        for (const part of parts) {
            part.first = Infinity;
            await FileStorageCache.forEachChunk(part.file, part.from, 1, async records => {
                part.first = Date.parse(records[0].Ts);
                return false;
            });
        }
        parts.sort((a, b) => a.first - b.first);
        const out = await fs.promises.open(tmp, 'w');
        try {
            for (const part of parts) {
                await FileStorageCache.forEachChunk(part.file, part.from, 20000, async records => {
                    const bytes = [];
                    for (const record of records) {
                        const encoded = FileStorageCache.encodeRecord(record);
                        if (encoded) bytes.push(encoded);
                    }
                    await out.write(Buffer.concat(bytes));
                });
            }
        } finally {
            await out.close();
        }
        await fs.promises.rename(tmp, target);
        this.resetProgress(streamKey);
        if (current !== target && parts.some(p => p.current)) {
            await fs.promises.unlink(current).catch(() => { });
        }
        for (const h of held) {
            await fs.promises.unlink(h.file).catch(() => { });
        }
        this.streamKeyPath.set(streamKey, target);
        return held.length;
    }
    // Calls fn with each run of up to max decoded records of a file, from start to its end; fn returning false stops
    static async forEachChunk(file, start, max, fn) {
        const input = await fs.promises.open(file, 'r');
        try {
            const size = (await input.stat()).size;
            let position = start;
            let length = Math.max(65536, max * 32);
            while (position < size) {
                const data = Buffer.alloc(Math.min(length, size - position));
                const { bytesRead } = await input.read(data, 0, data.length, position);
                const out = FileStorageCache.decode(data.subarray(0, bytesRead), max, position + bytesRead >= size);
                if (out.needMore && out.records.length === 0 && out.consumed === 0) {
                    length *= 2;            // one record bigger than the read
                    continue;
                }
                if (out.records.length > 0 && (await fn(out.records)) === false) break;
                if (out.exhausted || out.consumed === 0) break;
                position += out.consumed;
            }
        } finally {
            await input.close();
        }
    }
}

// Upload cycles that were waiting when the node closed, saved as the requests they would have been: one line of
// JSON per cycle, so the next start sends them exactly as they would have been sent. They don't go through the
// 2.4.3 cache format, which can't hold every value as sent ("" in a number stream comes back as 0). A value that
// JSON can't carry exactly (a Date, a Buffer, NaN) keeps its 2.4.3 cache encoding with it, for the case where the
// request later fails and is cached.
class Spool {
    constructor(storagePath, subFolder) {
        this.root = path.join(path.resolve(storagePath), SPOOL_DIR);
        this.dir = subFolder ? path.join(this.root, subFolder) : this.root;
        this.lastError = null;
    }
    // The spool in a subfolder of this one's folder
    sub(subFolder) {
        return new Spool(path.dirname(this.root), subFolder);
    }
    fileFor(streamKey) {
        return path.join(this.dir, `${streamKey}.jsonl`);
    }
    // Appends cycles, oldest first. Returns the cycles it couldn't save: those JSON can't hold (a BigInt, which the
    // request couldn't have sent either), or all of them if the write failed. Each append starts on a new line, so a
    // line a crash cut off can't swallow the next one. asCache: records that belong in the cache (it couldn't take
    // them); they come back as the cache would have given them.
    async append(streamKey, blocks, asCache) {
        const lines = [];
        const failed = [];
        for (const block of blocks) {
            const line = Spool.line(block, asCache);
            if (line === null) failed.push(block); else lines.push(line);
        }
        if (lines.length === 0) return failed;
        try {
            await fs.promises.mkdir(this.dir, { recursive: true });
            await fs.promises.appendFile(this.fileFor(streamKey), '\n' + lines.join('\n') + '\n');
            this.lastError = null;
            return failed;
        } catch (e) {
            this.lastError = e;
            return blocks;
        }
    }
    static line(block, asCache) {
        try {
            const legacy = {};
            block.forEach((record, i) => {
                if (asCache || Object.prototype.hasOwnProperty.call(record, LEGACY_BYTES) || !Spool.roundTrips(record.Val) || !Spool.roundTrips(record.ValStr)) {
                    const bytes = FileStorageCache.encodeRecord(record);
                    legacy[i] = bytes ? bytes.toString('base64') : null;
                }
            });
            if (asCache) return JSON.stringify({ v: 1, c: 1, b: [], e: legacy });
            const entry = { v: 1, b: block };
            if (Object.keys(legacy).length > 0) entry.e = legacy;
            if (block.sentBefore) entry.s = 1;
            return JSON.stringify(entry);
        } catch (e) {
            return null;
        }
    }
    // Values that come back from JSON exactly as they went in
    static roundTrips(value) {
        return value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0));
    }
    // Stream keys with saved cycles
    keys() {
        try {
            return fs.readdirSync(this.dir).filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -6));
        } catch (e) {
            return [];
        }
    }
    // Takes a stream's saved cycles off disk, oldest first. The file is renamed first, so another node sharing the
    // folder can't take them too.
    async take(streamKey) {
        const file = this.fileFor(streamKey);
        const taking = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.taking`;
        try {
            await fs.promises.rename(file, taking);
        } catch (e) {
            return [];
        }
        let text;
        try {
            text = await fs.promises.readFile(taking, 'utf8');
        } catch (e) {
            if (!fs.existsSync(file)) await fs.promises.rename(taking, file).catch(() => { });
            return [];
        }
        await fs.promises.unlink(taking).catch(() => { });
        return Spool.parse(text);
    }
    static parse(text) {
        const blocks = [];
        for (const line of text.split('\n')) {
            if (!line) continue;
            let entry;
            try {
                entry = JSON.parse(line);
            } catch (e) {
                continue;                   // a line cut off by a crash
            }
            if (!entry || entry.v !== 1 || !Array.isArray(entry.b)) continue;
            if (entry.c === 1) {
                // Cache records: decoded from their cache encoding, as 2.4.3 reads its cache
                const bytes = Object.keys(entry.e || {}).sort((a, b) => a - b).map(i => entry.e[i]).filter(x => typeof x === 'string');
                const records = FileStorageCache.decode(Buffer.concat(bytes.map(x => Buffer.from(x, 'base64'))), Infinity, true).records;
                Object.defineProperty(records, 'asCache', { value: true });
                blocks.push(records);
                continue;
            }
            if (entry.e && typeof entry.e === 'object') {
                for (const [i, encoded] of Object.entries(entry.e)) {
                    const record = entry.b[Number(i)];
                    if (record && typeof record === 'object') {
                        Object.defineProperty(record, LEGACY_BYTES, { value: typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : null });
                    }
                }
            }
            // A cycle 2.4.3 had already sent when the node closed (see the uploader's takeSpool)
            if (entry.s === 1) Object.defineProperty(entry.b, 'sentBefore', { value: true });
            blocks.push(entry.b);
        }
        return blocks;
    }
    // At start-up: cycles a crash left half-taken (a .taking file named over a minute ago) go back in front of the
    // stream's saved cycles, and a removed node's cycles (subFolder) move into this spool
    async recover(subFolder) {
        let names = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch (e) { }
        for (const name of names.filter(n => n.endsWith('.taking'))) {
            const file = path.join(this.dir, name);
            try {
                const takenAt = Number((/\.jsonl\.\d+-(\d+)-/.exec(name) || [])[1]);
                if (!(Date.now() - takenAt >= 60000)) continue;
                const target = this.fileFor(name.slice(0, name.indexOf('.jsonl.')));
                const rest = fs.existsSync(target) ? await fs.promises.readFile(target, 'utf8') : '';
                await fs.promises.writeFile(`${target}.tmp`, (await fs.promises.readFile(file, 'utf8')) + '\n' + rest);
                await fs.promises.rename(`${target}.tmp`, target);
                await fs.promises.unlink(file);
            } catch (e) { }
        }
        if (subFolder) await this.adopt(subFolder);
    }
    // Moves the cycles saved in a subfolder (a removed node's) into this spool, and removes the subfolder
    async adopt(subFolder) {
        const from = path.join(this.root, subFolder);
        let names = [];
        try {
            names = fs.readdirSync(from).filter(name => name.endsWith('.jsonl'));
        } catch (e) {
            return 0;
        }
        await fs.promises.mkdir(this.dir, { recursive: true });
        for (const name of names) {
            const file = path.join(from, name);
            const text = await fs.promises.readFile(file, 'utf8');
            await fs.promises.appendFile(path.join(this.dir, name), '\n' + text);
            await fs.promises.unlink(file);
        }
        await fs.promises.rmdir(from).catch(() => { });
        return names.length;
    }
}

module.exports = { Pool, FileStorageCache, Spool, DataType, LEGACY_BYTES };
