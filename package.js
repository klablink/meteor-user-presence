Package.describe({
    name: 'konecty:user-presence',
    summary: 'Track user status',
    version: '2.7.0',
    git: 'https://github.com/Konecty/meteor-user-presence',
});

Package.onUse(function(api) {
    api.versionsFrom(['2.13.3', '3.0-beta.0']);

    api.use('tracker');
    api.use('check');
    api.use('ecmascript');
    api.use('mongo');

    api.addFiles('common/common.js');
    api.addFiles('server/server.js', ['server']);
    api.addFiles('server/monitor.js', ['server']);
    api.addFiles('client/client.js', ['client']);

    api.export(['UserPresence', 'UsersSessions'], ['server', 'client']);
    api.export(['UserPresenceMonitor', 'UserPresenceEvents'], ['server']);
});

Package.onTest(function(api) {
    api.use('tinytest');
    api.use('konecty:user-presence');
    api.addFiles('user-presence-tests.js');
});

Npm.depends({
    colors: '1.3.2',
});

