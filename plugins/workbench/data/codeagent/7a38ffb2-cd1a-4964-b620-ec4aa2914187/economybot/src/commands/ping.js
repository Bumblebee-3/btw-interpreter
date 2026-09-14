module.exports = {
  // Command name
  name: "ping",
  // This is an interaction (slash) command
  type: "interaction",
  prototype: "slash",
  // Command code – replies with Pong! and the bot's latency
  code: `$interactionReply[Pong! Latency: $ping ms]`
};