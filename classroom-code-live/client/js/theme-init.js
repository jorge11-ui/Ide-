const themeKey = document.currentScript?.dataset.themeKey;
try {
  if (themeKey && localStorage.getItem(themeKey) === "light") document.documentElement.setAttribute("data-theme", "light");
} catch (error) {}
