var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');

test('init ClusterSupervisor', function (assert) {
    var nc = new ClusterSupervisor({
        respawnWorkerCount: 0,
        exec: __dirname + '/mock-server.js',
        numCPUs: 8
    });
    var cluster = nc.start();

    if (cluster) {
        assert.strictEqual(Object.keys(cluster.workers).length, 8);

        setTimeout(function() {
            Object.keys(cluster.workers).forEach(function (id) {
                cluster.workers[id].kill();
            });

            assert.end();
        }, 1000);
    }
});
