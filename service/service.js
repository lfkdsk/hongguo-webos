'use strict';

const Service = require('webos-service');
const { HongguoServer } = require('./server');

const service = new Service('com.lfkdsk.hongguo.service');
const server = new HongguoServer();
const ready = server.listen();
let activity;

service.activityManager.create('while-app-is-open', (value) => { activity = value; });
service.register('ping', (message) => {
  ready.then(
    (port) => message.respond({ returnValue: true, port, token: server.token }),
    (error) => message.respond({ returnValue: false, errorText: String(error) }),
  );
});
service.register('stop', (message) => {
  server.close();
  message.respond({ returnValue: true });
  if (activity) service.activityManager.complete(activity, () => process.exit(0));
});

process.on('unhandledRejection', (error) => console.error('[hongguo]', error));

