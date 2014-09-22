var ClusterSupervisor = require('../cluster-supervisor.js');
var path = require('path');
var test = require('tape');

test('init ClusterSupervisor', function (assert) {
    var supervisor = new ClusterSupervisor({
        respawnWorkerCount: 0,
        exec: path.join(__dirname, 'mock-server.js'),
        numCPUs: 8
    });
    supervisor.start();

    assert.strictEqual(supervisor.countWorkers(), 8);

    setTimeout(function() {
        supervisor.stop();

        assert.end();
    }, 1000);
});
