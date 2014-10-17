'use strict';

process.title = 'nodejs ' + process.env.ROLE;

if (process.env.ROLE === 'rock') {
    require('./hodor-net-client-cluster');
} else if (process.env.ROLE === 'hard-place') {
    require('./hodor-net-server-cluster');
}

