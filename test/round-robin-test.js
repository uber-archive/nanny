'use strict';

var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');
var path = require('path');
var net = require('net');

test('communication with net server', function (assert) {
    // This test verifies that all of the workers are indeed sharing the 0th
    // port.

    var numCPUs = 4;
    // The number of connections to send ourself to check whether they produce
    // a consistent round-robin order.
    var numChecks = 10;

    var supervisor = new ClusterSupervisor({
        respawnWorkerCount: 0,
        exec: path.join(__dirname, 'hodor-net-server.js'),
        workerCount: numCPUs,
        createEnvironment: function () {
            return {
                HODOR_NAME: this.id,
                HODOR_PORT: 0
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
        worker.on('message', onmessage);
    });

    var listening = 0;
    function onlistening(port) {
        listening++;
        if (listening === numCPUs) {
            collect(0, port);
        }
    }

    // Workers do not necessarily enter the load balancer in the order that
    // they start.
    // This method observes the order of responses through one rotation through
    // the load balancer.
    var workerIds = [];
    function collect(index, port) {
        if (index === numCPUs) {
            expect(0, port);
        } else {
            var client = net.connect(port);
            client.on('data', function (data) {
                var workerId = +data.toString();
                workerIds.push(workerId);
                collect(index + 1, port);
            });
        }
    }

    // This method verifies that the load balancer rotates round robin in the
    // order established by collecting the first round.
    function expect(index, port) {
        if (index === numChecks) {
            supervisor.stop(function () {
                assert.end();
            });
        } else {
            var client = net.connect(port);
            client.on('data', function (data) {
                var actualId = +data.toString();
                var expectedId = workerIds[index % numCPUs];
                assert.strictEqual(actualId, expectedId);
                expect(index + 1, port);
            });
        }
    }

});

