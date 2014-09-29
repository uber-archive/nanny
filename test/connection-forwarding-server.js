'use strict';

var net = require('net');

var server = net.createServer();

server.listen(0, function () {
    var address = server.address();
    process.send({cmd: 'TEST_LISTENING', port: address.port});
});

server.on('error', function (error) {
    process.end({cmd: 'TEST_ERROR', error: error.message});
});

process.on('message', function (message) {
    if (message.cmd === 'TEST_EXIT') {
        server.close();
    }
});

