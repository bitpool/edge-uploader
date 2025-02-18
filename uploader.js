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
            // Add the new value
            this.values.push({ timestamp, value });
            this.timestamps.add(timestamp); // Add to the set

            // Ensure array does not exceed MAX_RECORDS_PER_STREAM - delete the oldest
            if (this.values.length > MAX_RECORDS_PER_STREAM) {
                this.values.shift();
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

class FileStorageCache {

    constructor(storagePath) {
        this.streamKeyPath = new Map();
        this.storagePath = storagePath;
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
        }
        this.loadFiles();
    }
    loadFiles() {
        try {
            const files = fs.readdirSync(this.storagePath);
            const binFiles = files.filter(file => file.endsWith('.bin'));

            if (binFiles && binFiles.length > 0) {
                binFiles.forEach(async (file) => {
                    const streamKey = path.basename(file, '.bin');
                    const filePath = path.join(this.storagePath, file);

                    try {
                        const stats = await fs.promises.stat(filePath);
                        const fileAgeMillSecs = Date.now() - stats.mtimeMs;
                        const fileSizeBytes = stats.size;

                        if (fileSizeBytes > MAX_FILE_SIZE_BYTES || fileAgeMillSecs > MAX_FILE_AGE_MILLI_SECS) {
                            try {
                                await fs.promises.unlink(filePath);
                            } catch (deleteError) { }
                        } else {
                            this.streamKeyPath.set(streamKey, filePath);
                        }

                    } catch (statError) { }
                });
            }
        } catch (e) { }
    }

    getSize() {
        return this.streamKeyPath.size;
    }
    listStoredKeys() {
        if (this.streamKeyPath.size === 0) {
            return null;
        }
        return this.streamKeyPath;
    }
    async appendData(streamKey, dataArray) {
        let filePath = null;
        let writeStream = null;

        try {
            if (this.streamKeyPath.has(streamKey)) {
                filePath = this.streamKeyPath.get(streamKey);

                if (!fs.existsSync(filePath)) {
                    return false;
                }
            } else {
                filePath = path.join(this.storagePath, `${streamKey}.bin`);
                this.streamKeyPath.set(streamKey, filePath);
            }

            writeStream = fs.createWriteStream(filePath, { flags: 'a' });

            // Loop the bitpool data array
            dataArray.forEach(data => {
                try {
                    if (data.Val !== null && data.Val !== undefined) {
                        // Store timestamp and data as 64-bit floats (doubles)
                        const buffer = Buffer.allocUnsafe(16);                  // 8 bytes for timestamp, 8 bytes for data
                        buffer.writeDoubleBE(new Date(data.Ts).getTime(), 0);   // Write the timestamp (first 8 bytes) - input is ISO string
                        buffer.writeDoubleBE(data.Val, 8);                      // Write the number (next 8 bytes)
                        writeStream.write(buffer);                              // Write the buffer to the stream
                    } else if (data.ValStr !== null && data.ValStr !== undefined) {
                        // Store the timestamp and string (null-terminated)
                        const stringBuffer = Buffer.from(data.ValStr, 'utf8');  // Convert the string to a buffer
                        const nullTerminator = Buffer.from([0]);                // Null terminator (\0)
                        const timestampBuffer = Buffer.allocUnsafe(8);          // 8 bytes for timestamp
                        timestampBuffer.writeDoubleBE(new Date(data.Ts).getTime(), 0);

                        // Concat and write the buffers (timestamp + string + null terminator)
                        const totalBuffer = Buffer.concat([timestampBuffer, stringBuffer, nullTerminator]);
                        writeStream.write(totalBuffer);
                    }
                } catch (e) { }
            });

        } catch (e) {
            return false

        } finally {
            if (writeStream !== null && writeStream !== undefined) {
                await new Promise(resolve => writeStream.end(resolve)); // Ensure the stream is properly closed
            }
        }
        return true
    }
    async retrieveData(streamKey, dataType) {
        let fileHandle = null;
        let dataEntries = [];

        try {
            if (this.streamKeyPath.has(streamKey)) {
                // If exist then use the path
                const filePath = this.streamKeyPath.get(streamKey);
                fileHandle = await fs.promises.open(filePath, 'r');
                let fileData = await fileHandle.readFile();
                let offset = 0;

                while (offset < fileData.length) {
                    try {
                        // Read the timestamp (always 8 bytes)
                        let timestamp = fileData.readDoubleBE(offset);
                        let dataString = null;
                        let dataNumber = null;
                        offset += 8;
                        if (dataType === DataType.DOUBLE) {
                            // Timestamp and data as 64-bit floats (doubles)
                            dataNumber = fileData.readDoubleBE(offset);
                            offset += 8;
                        } else if (dataType === DataType.STRING) {
                            // Find the null terminator for the string
                            const nullIndex = fileData.indexOf(0, offset);
                            if (nullIndex === -1) break; // No null terminator found, break the loop
                            // Extract the string (everything from offset to nullIndex)
                            dataString = fileData.subarray(offset, nullIndex).toString('utf8');
                            offset = nullIndex + 1; // Move past the null terminator
                        } else {
                            continue;
                        }

                        dataEntries.push({
                            Ts: new Date(timestamp).toISOString(),
                            Val: dataType === DataType.DOUBLE ? dataNumber : null,
                            ValStr: dataType === DataType.STRING ? dataString : null,
                            Calculated: false
                        });

                    } catch (e) { }
                }

            }
        } catch (e) {
        } finally {
            if (fileHandle !== null) {
                await fileHandle.close();
            }
        }
        return dataEntries;
    }

    streamKeyExists(streamKey) {
        if (this.streamKeyPath.has(streamKey)) {
            const filePath = this.streamKeyPath.get(streamKey);

            if (fs.existsSync(filePath)) {
                return true;
            } else {
                this.streamKeyPath.delete(filePath);
                return false;
            }
        } else {
            // The map does not have an entry for this key but the file exist? So create one
            const filePath = path.join(this.storagePath, `${streamKey}.bin`);
            if (fs.existsSync(filePath)) {
                this.streamKeyPath.set(streamKey, filePath);
                return true;
            } else {
                return false;
            }
        }
    }
    purge() {
        try {
            this.streamKeyPath.forEach((value, key) => {
                this.deleteFile(key);
            });
        } catch (e) { }
    }

    deleteFile(streamKey) {
        try {
            if (this.streamKeyPath.has(streamKey)) {
                const filePath = this.streamKeyPath.get(streamKey);

                if (fs.existsSync(filePath)) {
                    fs.unlink(filePath, (err) => {
                        if (!err) {
                            this.streamKeyPath.delete(streamKey);
                        }
                    });
                }
            }
        } catch (e) {
            return false
        }
        return true;
    }
}

module.exports = { Pool, FileStorageCache, DataType };