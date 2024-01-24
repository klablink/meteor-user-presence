import 'colors';
import { UsersSessions } from '../common/common';
import { UserPresenceMonitor, UserPresenceEvents } from './monitor';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
// nimport { InstanceStatus } from 'meteor/konecty:multiple-instances-status';

// KLASYNC: _ensureIndex is deprecated. Use createIndex instead.
UsersSessions.createIndex({'connections.instanceId': 1}, {sparse: 1, name: 'connections.instanceId'});
UsersSessions.createIndex({'connections.id': 1}, {sparse: 1, name: 'connections.id'});

const allowedStatus = ['online', 'away', 'busy', 'offline'];

const {ENABLE_PRESENCE_LOGS} = process.env;
let logEnable = ENABLE_PRESENCE_LOGS === 'true';

const log = function log(msg, color) {
	if (logEnable) {
		if (color) {
            // eslint-disable-next-line no-console
			console.log(msg[color]);
		} else {
            // eslint-disable-next-line no-console
			console.log(msg);
		}
	}
};

const logRed = function logRed(...args) {
	log(args.join(' '), 'red');
};
const logGrey = function logGrey(...args) {
	log(args.join(' '), 'grey');
};
const logGreen = function logGreen(...args) {
	log(args.join(' '), 'green');
};
const logYellow = function logYellow(...args) {
	log(args.join(' '), 'yellow');
};

const checkUser = async function checkUser(id, userId) {
	if (!id || !userId || id === userId) {
		return true;
	}
	const user = await Meteor.users.findOneAsync(id, { fields: { _id: 1 } });
	if (user) {
		throw new Meteor.Error('cannot-change-other-users-status');
	}

	return true;
};

const UserPresence = {
	activeLogs() {
		logEnable = true;
	},

	async removeConnectionsByInstanceId(instanceId) {
		logRed('[user-presence] removeConnectionsByInstanceId', instanceId);
		const update = {
			$pull: {
				connections: {
					instanceId,
				},
			},
		};

		await UsersSessions.updateAsync({}, update, {multi: true});
	},

    async removeAllConnections() {
		logRed('[user-presence] removeAllConnections');
		await UsersSessions.removeAsync({});
	},

	getConnectionHandle(connectionId) {
		const internalConnection = Meteor.server.sessions.get(connectionId);

		if (!internalConnection) {
			return null;
		}

		return internalConnection.connectionHandle;
	},

	async createConnection(userId, connection, status, metadata) {
		// if connections are invalid, does not have a userId or is already closed, don't save it on db
		if (!userId || !connection.id) {
			return;
		}

		const connectionHandle = UserPresence.getConnectionHandle(connection.id);

		if (!connectionHandle || connectionHandle.closed) {
			return;
		}

		connectionHandle.UserPresenceUserId = userId;

		status = status || 'online';

		logGreen('[user-presence] createConnection', userId, connection.id, status, metadata);

		const query = {
			_id: userId,
		};

		const now = new Date();

		let instanceId;
		if (Package['konecty:multiple-instances-status']) {
			instanceId = InstanceStatus.id();
		}

		const update = {
			$push: {
				connections: {
					id: connection.id,
					instanceId,
					status,
					_createdAt: now,
					_updatedAt: now,
				},
			},
		};

		if (metadata) {
			update.$set = {
				metadata,
			};
			connection.metadata = metadata;
		}

		// make sure closed connections are being created
		if (!connectionHandle.closed) {
			await UsersSessions.upsertAsync(query, update);
		}
	},

	async setConnection(userId, connection, status) {
		if (!userId) {
			return null;
		}

		logGrey('[user-presence] setConnection', userId, connection.id, status);

		const query = {
			_id: userId,
			'connections.id': connection.id,
		};

		const now = new Date();

		const update = {
			$set: {
				'connections.$.status': status,
				'connections.$._updatedAt': now,
			},
		};

		if (connection.metadata) {
			update.$set.metadata = connection.metadata;
		}

		const count = await UsersSessions.updateAsync(query, update);

		if (count === 0) {
			return await UserPresence.createConnection(userId, connection, status, connection.metadata);
		}

		if (status === 'online') {
			await Meteor.users.updateAsync({_id: userId, statusDefault: 'online', status: {$ne: 'online'}}, {$set: {status: 'online'}});
		} else if (status === 'away') {
			await Meteor.users.updateAsync({_id: userId, statusDefault: 'online', status: {$ne: 'away'}}, {$set: {status: 'away'}});
		}

        return null;
	},

	async setDefaultStatus(userId, status) {
		if (!userId) {
			return;
		}

		if (allowedStatus.indexOf(status) === -1) {
			return;
		}

		logYellow('[user-presence] setDefaultStatus', userId, status);

		const update = await Meteor.users.updateAsync({_id: userId, statusDefault: {$ne: status}}, {$set: {statusDefault: status}});

		if (update > 0) {
			await UserPresenceMonitor.processUser(userId, { statusDefault: status });
		}
	},

	async removeConnection(connectionId) {
		logRed('[user-presence] removeConnection', connectionId);

		const query = {
			'connections.id': connectionId,
		};

		const update = {
			$pull: {
				connections: {
					id: connectionId,
				},
			},
		};

		return await UsersSessions.updateAsync(query, update);
	},

	start() {
		Meteor.onConnection(function onConnection(connection) {
			const session = Meteor.server.sessions.get(connection.id);

			connection.onClose(async function onClose() {
				if (!session) {
					return;
				}

				const {connectionHandle} = session;

				// mark the connection as closed, so if it drops in the middle of the process, it doesn't even is created
				if (!connectionHandle) {
					return;
				}
				connectionHandle.closed = true;

				if (connectionHandle.UserPresenceUserId != null) {
					await UserPresence.removeConnection(connection.id);
				}
			});
		});

		process.on('exit', async function exit() {
			if (Package['konecty:multiple-instances-status']) {
				await UserPresence.removeConnectionsByInstanceId(InstanceStatus.id());
			} else {
				await UserPresence.removeAllConnections();
			}
		});

		if (Package['accounts-base']) {
			Accounts.onLogin(async function onLogin(login) {
				await UserPresence.createConnection(login.user._id, login.connection);
			});

			Accounts.onLogout(async function onLogout(login) {
				await UserPresence.removeConnection(login.connection.id);
			});
		}

		Meteor.publish(null, async function publish() {
			if (this.userId == null && this.connection && this.connection.id) {
				const connectionHandle = UserPresence.getConnectionHandle(this.connection.id);
				if (connectionHandle && connectionHandle.UserPresenceUserId != null) {
					await UserPresence.removeConnection(this.connection.id);
				}
			}

			this.ready();
		});

		UserPresenceEvents.on('setStatus', async function setStatus(userId, status) {
			const user = Meteor.users.findOneAsync(userId);
			const statusConnection = status;

			if (!user) {
				return;
			}

            const { statusDefault } = user || {};
			if (statusDefault != null && status !== 'offline' && statusDefault !== 'online') {
				status = statusDefault;
			}

			const query = {
				_id: userId,
				$or: [
					{status: {$ne: status}},
					{statusConnection: {$ne: statusConnection}},
				],
			};

			const update = {
				$set: {
					status,
					statusConnection,
				},
			};

			const result = await Meteor.users.updateAsync(query, update);

			// if nothing updated do not emit anything
			if (result) {
				UserPresenceEvents.emit('setUserStatus', user, status, statusConnection);
			}
		});

		Meteor.methods({
			async 'UserPresence:connect'(id, metadata) {
				check(id, Match.Maybe(String));
				check(metadata, Match.Maybe(Object));
				this.unblock();
				await checkUser(id, this.userId);
				await UserPresence.createConnection(id || this.userId, this.connection, 'online', metadata);
			},

			async 'UserPresence:away'(id) {
				check(id, Match.Maybe(String));
				this.unblock();
				await checkUser(id, this.userId);
				await UserPresence.setConnection(id || this.userId, this.connection, 'away');
			},

			async 'UserPresence:online'(id) {
				check(id, Match.Maybe(String));
				this.unblock();
				await checkUser(id, this.userId);
				await UserPresence.setConnection(id || this.userId, this.connection, 'online');
			},

			async 'UserPresence:setDefaultStatus'(id, status) {
				check(id, Match.Maybe(String));
				check(status, Match.Maybe(String));
				this.unblock();

				// backward compatible (receives status as first argument)
				if (arguments.length === 1) {
					await UserPresence.setDefaultStatus(this.userId, id);
					return;
				}
				await checkUser(id, this.userId);
				await UserPresence.setDefaultStatus(id || this.userId, status);
			},
		});
	},
};

export { UserPresence };
