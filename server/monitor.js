/* globals UserPresenceMonitor, UsersSessions, InstanceStatus */
const EventEmitter = Npm.require('events');

UserPresenceEvents = new EventEmitter();

function monitorUsersSessions() {
	UsersSessions.find({}).observe({
		added(record) {
			UserPresenceMonitor.processUserSession(record, 'added');
		},
		changed(record) {
			UserPresenceMonitor.processUserSession(record, 'changed');
		},
		removed(record) {
			UserPresenceMonitor.processUserSession(record, 'removed');
		},
	});
}

function monitorDeletedServers() {
	InstanceStatus.getCollection().find({}, {fields: {_id: 1}}).observeChanges({
		removed(id) {
			UserPresence.removeConnectionsByInstanceId(id);
		},
	});
}

async function removeLostConnections() {
	if (!Package['konecty:multiple-instances-status']) {
		return await UsersSessions.removeAsync({});
	}

    const idsList = await InstanceStatus.getCollection().find({}, {fields: {_id: 1}}).fetchAsync();
	const ids = idsList.map(function(id) {
		return id._id;
	});

	const update = {
		$pull: {
			connections: {
				instanceId: {
					$nin: ids,
				},
			},
		},
	};
	await UsersSessions.updateAsync({}, update, {multi: true});
}

UserPresenceMonitor = {
	/**
	 * The callback will receive the following parameters: user, status, statusConnection
	 */
	onSetUserStatus(callback) {
		UserPresenceEvents.on('setUserStatus', callback);
	},

	// following actions/observers will run only when presence monitor turned on
	async start() {
		monitorUsersSessions();
		await removeLostConnections();

		if (Package['konecty:multiple-instances-status']) {
			monitorDeletedServers();
		}
	},

	async processUserSession(record, action) {
		if (action === 'removed' && (record.connections == null || record.connections.length === 0)) {
			return;
		}

		if (record.connections == null || record.connections.length === 0 || action === 'removed') {
			UserPresenceMonitor.setStatus(record._id, 'offline', record.metadata);

			if (action !== 'removed') {
				await UsersSessions.removeAsync({_id: record._id, 'connections.0': {$exists: false} });
			}
			return;
		}

		let connectionStatus = 'offline';
		record.connections.forEach(function(connection) {
			if (connection.status === 'online') {
				connectionStatus = 'online';
			} else if (connection.status === 'away' && connectionStatus === 'offline') {
				connectionStatus = 'away';
			}
		});

		UserPresenceMonitor.setStatus(record._id, connectionStatus, record.metadata);
	},

	async processUser(id, fields) {
		if (fields.statusDefault == null) {
			return;
		}

		const userSession = await UsersSessions.findOneAsync({_id: id});

		if (userSession) {
			await UserPresenceMonitor.processUserSession(userSession, 'changed');
		}
	},

	setStatus(id, status, metadata) {
		UserPresenceEvents.emit('setStatus', id, status, metadata);
	},
};
