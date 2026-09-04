function text(content,plugins=[]) {
  return { type: "text", content,plugins };
}

function rich(content, actions = [],plugins=[]) {
  return { type: "rich", content, actions,plugins };
}

function ask(question, options = []) {
  return { type: "ask", content: question, options };
}

function confirm(title, body, on_confirm_shell) {
  return { type: "confirm", title, body, on_confirm_shell };
}

module.exports = { text, rich, ask, confirm };
