'use strict';

var http = require('http');

var server = http.createServer();

server.on('request', function (request, response) {
    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.end(process.env.PROCESS_LOGICAL_ID);
});

server.listen(0, function () {
    var address = server.address();
    process.send({cmd: 'TEST_LISTENING', address: address});
});

