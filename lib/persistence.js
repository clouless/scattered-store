"use strict";

var Q = require('q');
var crypto = require('crypto');
var pathUtil = require('path');
var jetpack = require('fs-jetpack');
var concurrentReader = require('./concurrent_reader');

var newLineCode = 10; // '\n' character

var encodeForStorage = function (key, value) {
    var type;
    var data;
    
    if (Buffer.isBuffer(value)) {
        type = 'binary';
        data = value;
    } else {
        type = 'json';
        data = new Buffer(JSON.stringify(value));
    }
    
    var fileHeaderStr = JSON.stringify({
        type: type,
        key: key
    });
    var fileHeader = new Buffer(fileHeaderStr + String.fromCharCode(newLineCode));
    
    return Buffer.concat([fileHeader, data]);
};

var decodeFromStorage = function (buf) {
    // Extract file header
    var i = 0;
    while (i < buf.length) {
        if (buf[i] === newLineCode) {
            break;
        }
        i += 1;
    }
    var fileHeaderBuf = buf.slice(0, i);
    var fileHeader = JSON.parse(fileHeaderBuf.toString());
    
    var dataBuf = buf.slice(i + 1); // Skip the new line character...
    // ... and everything after new line is data:
    
    var entry = {
        key: fileHeader.key
    };
    
    if (fileHeader.type === 'binary') {
        entry.value = dataBuf;
    } else {
        entry.value = JSON.parse(dataBuf.toString(), dateParser);
    }
    
    return entry;
};

module.exports.isValidKey = function (key) {
    if (typeof key !== 'string' || key.length === 0) {
        return false;
    }
    return true;
};

module.exports.create = function (storageDir) {
    
    storageDir = jetpack.cwd(storageDir);
    
    var transformKeyToFilePath = function (key) {
        var sha = crypto.createHash('sha1');
        sha.update(key);
        var hex = sha.digest('hex');
        var dir = hex.substring(0, 2);
        var file = hex.substring(2);
        return storageDir.path(dir, file);
    };
    
    var set = function (key, value) {
        var filePath = transformKeyToFilePath(key);
        var buf = encodeForStorage(key, value);
        return storageDir.writeAsync(filePath, buf, { safe: true });
    };
    
    var get = function (key) {
        var deferred = Q.defer();
        var filePath = transformKeyToFilePath(key);
        storageDir.readAsync(filePath, 'buf', { safe: true })
        .then(function (buf) {
            if (buf) {
                deferred.resolve(decodeFromStorage(buf).value);
            } else {
                deferred.resolve(null);
            }
        });
        return deferred.promise;
    };
    
    var del = function (key) {
        var deferred = Q.defer();
        var filePath = transformKeyToFilePath(key);
        storageDir.removeAsync(filePath)
        .then(function () {
            deferred.resolve();
        });
        return deferred.promise;
    };
    
    var each = function (fn) {
        var deferred = Q.defer();
        
        var reader = concurrentReader(function (buf) {
            var item = decodeFromStorage(buf);
            fn(item.key, item.value);
        }, deferred.resolve);
        
        storageDir.listAsync('.')
        .then(function (dirs) {
            var promises = [];
            
            dirs.forEach(function (dirname) {
                var p = storageDir.listAsync(dirname);
                promises.push(p);
                p.then(function (files) {
                    files.forEach(function (filename) {
                        reader.addPath(storageDir.path(dirname, filename));
                    });
                });
            });
            
            Q.all(promises).then(reader.noMorePathsForYou);
        });
        
        return deferred.promise;
    };
    
    return {
        set: set,
        get: get,
        del: del,
        each: each,
    };
};

// -----------------------------------------------
// Utils

var dateParser = function (key, value) {
    var reISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;
    if (typeof value === 'string') {
        if (reISO.exec(value)) {
            return new Date(value);
        }
    }
    return value;
};