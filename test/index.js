var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');

test('ClusterSupervisor is a function', function (assert) {
    assert.strictEqual(typeof ClusterSupervisor, 'function');
    assert.end();
});
