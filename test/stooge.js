'use strict';

var role = process.env.ROLE;
process.title = role;
if (role === 'larry') {
    // Larry is a worker that never reports his event loop healthy because he's
    // spinning.
    while (true) { void 0; }
} else if (role === 'curly') {
    // Curly is a worker who hoards memory and refuses to shut down.
    process.on('SIGTERM', function () {
        console.log('CURLY NO DIE');
    });
    var head;
    setInterval(function () {
        for (var index = 0; index < 1000; index++) {
            head = {next: head};
        }
    }, 10);
} else if (role === 'moe') {
    // Moe is a worker that crashes.
    setTimeout(function () {
        throw new Error('MOE CAN\'T TAKE THIS ANY LONGER');
    }, 10000);
//} else if (role === 'shemp') {
    // This is a worker that does nothing in particular, but if you kill it,
    // the supervisor will recreate it.
//} else if (role === 'joe') {
    // TODO This is a worker that runs properly but starts and stops listening
    // periodically.
//} else if (role === 'curly-joe') {
}

