// This test verifies that require.main === module in a worker.
'use strict';

var tape = require('tape');
var path = require('path');
var ClusterSupervisor = require('../cluster-supervisor');

tape('main module should be worker module', function (assert) {

    var supervisor = new ClusterSupervisor({
        exec: path.join(__dirname, 'main-module.js'),
        workerCount: 1
    });

    supervisor.start();
    supervisor.workers[0].process.on('message', function (message) {
        if (message.cmd === 'TEST_RESULT') {
            assert.ok(message.result, 'main module is the worker module');
            supervisor.stop(function () {
                assert.end();
            });
        }
    });

});

