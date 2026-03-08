const askHandler = require('./ask');
const helpHandler = require('./help');
const reviewHandler = require('./review');
const explainHandler = require('./explain');
const impactHandler = require('./impact');
const describeHandler = require('./describe');

const HANDLERS = {
  ask: askHandler.handleAskCommand,
  help: helpHandler.handleHelpCommand,
  review: reviewHandler.handleReviewCommand,
  explain: explainHandler.handleExplainCommand,
  impact: impactHandler.handleImpactCommand,
  describe: describeHandler.handleDescribeCommand,
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
  review: reviewHandler,
  explain: explainHandler,
  impact: impactHandler,
  describe: describeHandler,
};
