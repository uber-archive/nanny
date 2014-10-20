'use strict';

// This is a client that produces load on hodor-net-server.

process.title = 'nodejs hodor client';

var net = require('net');
var debuglog = require('debuglog');
var log = debuglog('hodorclient');

var BACKOFF = 1000;

function next() {
    process.stderr.write('.');
    var connected = false;
    var data = "";
    var done = false;

    var client = net.connect(+process.env.HODOR_PORT, 'localhost', function () {
        connected = true;
    });

    client.setEncoding('utf-8');

    client.on('error', function (error) {
        log('unexpected error', error.message);
        setTimeout(next, BACKOFF);
    });
    client.on('data', function (_data) {
        data += _data;
    });
    client.on('finish', end);
    client.on('end', end);

    function end() {
        // Should be called once for 'end', once for 'finish'.
        if (!done) {
            done = true;
            if (!connected) {
                log('unexpected end before connection');
                setTimeout(next, BACKOFF);
            } else if (data !== 'HODOR') {
                log('unexpected response', JSON.stringify(data));
                setTimeout(next, BACKOFF);
            } else {
                next();
            }
        }
    }

}

// Five concurrent requests
next();
next();
next();
next();
next();

