class ReminderPlugin {
  constructor(reminder_manager) {
    this.reminderManager = reminder_manager;
  }

  async createReminder(input) {
    if (!this.reminderManager) {
      return "Reminder system is not initialized.";
    }

    const result = this.reminderManager.addReminderFromInput(input);
    if (!result.ok) {
      return result.message;
    }

    const due = new Date(result.reminder.dueAt);
    const when = due.toLocaleString();
    return `Reminder set for ${when}: ${result.reminder.text}`;
  }
}

module.exports = ReminderPlugin;
