import { Mongo } from 'meteor/mongo';

const UsersSessions = new Mongo.Collection('usersSessions');

export { UsersSessions };
