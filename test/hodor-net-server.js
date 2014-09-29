'use strict';

// This is a socket server that responds to all connections with its own name
// (process logical identifier)

var net = require('net');

var server = net.createServer();

server.on('connection', function (connection) {
    connection.end(process.env.PROCESS_LOGICAL_ID);
});

server.listen(0, function () {
    var address = server.address();
    process.send({cmd: 'TEST_LISTENING', address: address});
});

