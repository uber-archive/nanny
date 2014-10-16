'use strict';

var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');
var path = require('path');

test('connection forwarding', function (assert) {
    // This test verifies that all of the workers are indeed sharing the 0th
    // port.

    var supervisor = new ClusterSupervisor({
        respawnWorkerCount: 0,
        exec: path.join(__dirname, 'connection-forwarding-server.js'),
        numCPUs: 4
    });

    supervisor.start();

    supervisor.forEachWorker(function (worker) {
        function onmessage(message) {
            if (message.cmd === 'TEST_LISTENING') {
                var port = message.port;
                // This is the port that the child process obtained by calling listen.
                // The supervisor process should be listening on its behalf.
                onlistening(port);
            }
        }
        worker.process.on('message', onmessage);
    });


    var sharedPort;
    var workerCount = 0;
    function onlistening(port) {
        workerCount++;
        if (sharedPort === undefined) {
            sharedPort = port;
        } else {
            // Every worker should be listening on the same port
            assert.strictEquals(sharedPort, port);
        }
        if (workerCount === 4) {
            supervisor.forEachWorker(function (worker) {
                worker.process.send({cmd: 'TEST_EXIT'});
            });
            supervisor.stop();
            assert.end();
        }
    }

});

