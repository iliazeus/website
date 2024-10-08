const rootDataArg = document.documentElement.dataset.theme;
const stored = window.sessionStorage.getItem("theme");
const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

let theme = "light";
if (stored) theme = stored;
else if (prefersLight) theme = "light";
else if (prefersDark) theme = "dark";
else if (rootDataArg) theme = rootDataArg;

document.documentElement.dataset.theme = theme;

var toggleTheme = () => {
  const current = document.documentElement.dataset.theme;
  const next = current === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  window.sessionStorage.setItem("theme", next);
};

window.addEventListener("load", (e) => {
  e.preventDefault();
  document
    .querySelectorAll(".theme-toggle")
    .forEach((el) => el.addEventListener("click", toggleTheme));
});
