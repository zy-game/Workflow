import { Input } from "./widgets.js";
import { truncate } from "./text.js";
import { T } from "./theme.js";

export function createLoginForm(api) {
  const email = new Input({ prompt: "Email: ", placeholder: "you@example.com" });
  const password = new Input({ prompt: "Password: ", masked: true });
  return {
    email,
    password,
    async submit() {
      const emailValue = email.value;
      const passwordValue = password.value;
      email.setValue("");
      password.setValue("");
      return api.login(emailValue, passwordValue);
    },
  };
}

export function promptLogin({ api, screen, term, setEventHandler }) {
  return new Promise((resolve) => {
    let active = "email";
    let error = "";
    let submitting = false;
    const form = createLoginForm(api);
    const { email, password } = form;
    const width = Math.max(28, Math.min(64, screen.w - 8));
    const left = Math.max(2, Math.floor((screen.w - width) / 2));
    email.x = password.x = left;
    email.w = password.w = width;

    const render = () => {
      screen.clear(-1, T.BG);
      const top = Math.max(1, Math.floor(screen.h / 2) - 4);
      email.x = password.x = left;
      email.y = top + 2;
      password.y = top + 4;
      screen.text(left, top, truncate("DSH Login", width), { fg: T.ACCENT, attrs: 1 });
      screen.text(left, top + 1, "─".repeat(Math.max(1, width - 1)), { fg: T.BORDER });
      email.render(screen);
      password.render(screen);
      const hint = submitting ? "Signing in..." : "Enter submit · Tab switch · Ctrl+C exit";
      screen.text(left, top + 6, truncate(hint, width), { fg: T.FAINT });
      if (error) screen.text(left, top + 7, truncate(error, width), { fg: T.ERR });
      const cursor = (active === "email" ? email : password).cursorCell;
      const move = cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h` : "\x1b[?25l";
      term.output.write(screen.render() + move);
    };

    const submit = async () => {
      if (submitting) return;
      submitting = true;
      error = "";
      render();
      try {
        await form.submit();
        resolve();
      } catch (cause) {
        error = cause.message;
        submitting = false;
        active = "email";
        render();
      }
    };
    email.onEnter = () => { active = "password"; render(); };
    password.onEnter = submit;
    setEventHandler((event) => {
      if (event.type === "key" && event.ctrl && event.key === "c") {
        term.stop();
        process.exit(0);
      }
      if (event.type === "key" && event.name === "tab") {
        active = active === "email" ? "password" : "email";
        render();
        return;
      }
      if (!submitting) (active === "email" ? email : password).onKey(event);
      render();
    });
    render();
  });
}
