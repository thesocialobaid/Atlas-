// What sort of thing a file is, from the language the parser detected. This is
// the no-framework taxonomy; framework roles replace it when an adapter knows
// better. A handful of kinds, because a colour per language stops meaning
// anything after six.

export const CATEGORIES = ["code", "styles", "markup", "docs", "config", "assets", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  code: "Code",
  styles: "Styles",
  markup: "Markup",
  docs: "Docs",
  config: "Config",
  assets: "Assets",
  other: "Other",
};

const BY_LANGUAGE: Record<string, Category> = {};
const groups: [Category, string[]][] = [
  ["code", ["typescript", "javascript", "python", "go", "rust", "java", "csharp", "c", "cpp",
    "shell", "powershell", "ruby", "php", "kotlin", "swift", "scala", "vue", "svelte", "sql",
    "lua", "dart"]],
  ["styles", ["css", "scss", "sass", "less"]],
  ["markup", ["html", "xml"]],
  ["docs", ["markdown", "mdx", "txt", "rst"]],
  ["config", ["json", "yaml", "toml", "dockerfile", "makefile", "go-module", "go-sum", "lock"]],
  ["assets", ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "woff", "woff2", "ttf",
    "otf", "eot", "mp4", "webm", "mp3", "wav", "pdf"]],
];
for (const [category, languages] of groups) for (const l of languages) BY_LANGUAGE[l] = category;

export function categoryOf(file: { path: string; language: string }): Category {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  // Dotfiles (.gitignore, .babelrc) are tool configuration whatever they're called.
  if (name.startsWith(".")) return "config";
  return BY_LANGUAGE[file.language] ?? "other";
}
