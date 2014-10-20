'use strict';

var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');
var path = require('path');
var http = require('http');

test('communication with http server', function (assert) {
    // This test verifies that all of the workers are indeed sharing the 0th
    // port.

    var numCPUs = 4;

    var supervisor = new ClusterSupervisor({
        respawnWorkerCount: 0,
        exec: path.join(__dirname, 'hodor-http-server.js'),
        numCPUs: numCPUs,
        createEnvironment: function () {
            return {
                PROCESS_LOGICAL_ID: this.id
            };
        }
    });

    supervisor.start();

    supervisor.forEachWorker(function (worker) {
        function onmessage(message) {
            if (message.cmd === 'TEST_LISTENING') {
                var port = message.address.port;
                onlistening(port);
            }
        }
        worker.process.on('message', onmessage);
    });

    var listening = 0;
    function onlistening(port) {
        listening++;
        if (listening === numCPUs) {
            expect(0, port);
        }
    }

    var workerIds = {0: true, 1: true, 2: true, 3: true};
    function expect(index, port) {
        if (index === numCPUs) {
            // This loop should not produce any iterations.
            // All properties should be deleted by now, albeit not necessarily
            // in order.
            for (var workerId in workerIds) {
                if (workerIds.hasOwnProperty(workerId)) { // Because JSHint
                    workerId = undefined; // Because JSHint
                    assert(false); // There should be no more
                }
            }
            supervisor.stop(function () {
                assert.end();
            });
        } else {
            http.get('http://localhost:' + port, function (response) {
                assert.strictEqual(200, response.statusCode);
                response.on('data', function (data) {
                    var workerId = data.toString();
                    delete workerIds[workerId];
                    expect(index + 1, port);
                });
            });
        }
    }

});

