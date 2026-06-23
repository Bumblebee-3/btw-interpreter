function text(content) {
  return { type: "text", content };
}

function rich(content, actions = []) {
  return { type: "rich", content, actions };
}

function ask(question, options = []) {
  return { type: "ask", content: question, options };
}

function confirm(title, body, on_confirm_shell) {
  return { type: "confirm", title, body, on_confirm_shell };
}

module.exports = { text, rich, ask, confirm };
