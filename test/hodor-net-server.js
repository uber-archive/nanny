'use strict';

// This is a socket server that responds to all connections with its own name
// (process logical identifier)

process.title = 'nodejs hodor server';

var net = require('net');

var server = net.createServer();

server.on('connection', function (connection) {
    connection.setEncoding('utf-8');
    connection.end(process.env.HODOR_NAME);
});

server.listen(+process.env.HODOR_PORT, function () {
    var address = server.address();
    if (process.send) {
        process.send({cmd: 'TEST_LISTENING', address: address});
    }
});

