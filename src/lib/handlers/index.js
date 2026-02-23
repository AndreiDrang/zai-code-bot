const askHandler = require('./ask');
const helpHandler = require('./help');

const HANDLERS = {
  ask: askHandler.handleAskCommand,
  help: helpHandler.handleHelpCommand,
};

function getHandler(command) {
  return HANDLERS[command] || null;
}

function hasHandler(command) {
  return command in HANDLERS;
}

function getAllCommands() {
  return Object.keys(HANDLERS);
}

module.exports = {
  HANDLERS,
  getHandler,
  hasHandler,
  getAllCommands,
  ask: askHandler,
  help: helpHandler,
};
