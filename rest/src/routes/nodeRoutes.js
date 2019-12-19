/*
 * Copyright (c) 2016-present,
 * Jaguar0625, gimre, BloodyRookie, Tech Bureau, Corp. All rights reserved.
 *
 * This file is part of Catapult.
 *
 * Catapult is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Catapult is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Catapult.  If not, see <http://www.gnu.org/licenses/>.
 */

const routeResultTypes = require('./routeResultTypes');
const nodeInfoCodec = require('../sockets/nodeInfoCodec');
const nodePeersCodec = require('../sockets/nodePeersCodec');
const nodeTimeCodec = require('../sockets/nodeTimeCodec');
const catapult = require('catapult-sdk');

const packetHeader = catapult.packet.header;
const { PacketType } = catapult.packet;

const { BinaryParser } = catapult.parser;
const { convert } = catapult.utils;

const buildResponse = (packet, codec, resultType) => {
	const binaryParser = new BinaryParser();
	binaryParser.push(packet.payload);
	return { payload: codec.deserialize(binaryParser), type: resultType, formatter: 'ws' };
};

// Format node info to readable format.
const formatNodeInfo = info => ({
	friendlyName: info.friendlyName.toString(),
	host: info.host.toString(),
	publicKey: convert.uint8ToHex(info.publicKey)
});

// Sort by friendly name, then by host, and then by public
// key, to ensure stable sorting. Use lowercase, and use
// the default to break incase of ties.
const sortNodeInfo = (x, y) => {
	// Format so we can apply simple, case-sensitive sorting.
	x = formatNodeInfo(x);
	y = formatNodeInfo(y);

	// Sort by name, first lowercase, then case-sensitive.
	const xName = x.friendlyName;
	const yName = y.friendlyName;
	const xNameLower = xName.toLowerCase();
	const yNameLower = yName.toLowerCase();
	if (xNameLower < yNameLower) {
		return -1;
	} else if (yNameLower < xNameLower) {
		return 1;
	} else if (xName < yName) {
		return -1;
	} else if (yName < xName) {
		return 1;
	}

	// Tie, sort by host, first lowercase, then case-sensitive.
	const xHost = x.host;
	const yHost = y.host;
	const xHostLower = xHost.toLowerCase();
	const yHostLower = yHost.toLowerCase();
	if (xHostLower < yHostLower) {
		return -1;
	} else if (yHostLower < xHostLower) {
		return 1;
	} else if (xHost < yHost) {
		return -1;
	} else if (yHost < xHost) {
		return 1;
	}

	// Tie, sort by public key (not case-sensitive).
	const xPublicKeyLower = x.publicKey.toLowerCase();
	const yPublicKeyLower = y.publicKey.toLowerCase();
	if (xPublicKeyLower < yPublicKeyLower) {
		return -1;
	} else if (yPublicKeyLower < xPublicKeyLower) {
		return 1;
	} else {
		// Has to be the same node.
		return 0;
	}
}

module.exports = {
	register: (server, db, services) => {
		const { connections } = services;
		const { timeout } = services.config.apiNode;

		server.get('/node/info', (req, res, next) => {
			const packetBuffer = packetHeader.createBuffer(PacketType.nodeDiscoveryPullPing, packetHeader.size);
			return connections.singleUse()
				.then(connection => connection.pushPull(packetBuffer, timeout))
				.then(packet => {
					res.send(buildResponse(packet, nodeInfoCodec, routeResultTypes.nodeInfo));
					next();
				});
		});

		server.get('/node/peers', (req, res, next) => {
			const packetBuffer = packetHeader.createBuffer(PacketType.nodeDiscoveryPullPeers, packetHeader.size);
			return connections.singleUse()
				.then(connection => connection.pushPull(packetBuffer, timeout))
				.then(packet => {
					const response = buildResponse(packet, nodePeersCodec, routeResultTypes.nodeInfo);
					response.payload.sort(sortNodeInfo);
					res.send(response);
					next();
				});
		});

		server.get('/node/time', (req, res, next) => {
			const packetBuffer = packetHeader.createBuffer(PacketType.timeSyncNodeTime, packetHeader.size);
			return connections.singleUse()
				.then(connection => connection.pushPull(packetBuffer, timeout))
				.then(packet => {
					res.send(buildResponse(packet, nodeTimeCodec, routeResultTypes.nodeTime));
					next();
				});
		});
	}
};
