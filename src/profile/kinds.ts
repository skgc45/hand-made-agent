import type { Profile } from "./index.js";

export const FILE_TOOL_KINDS: NonNullable<Profile["kinds"]> = {
  list_files: "read",
  read_file: "read",
  glob: "read",
  grep: "read",
  todo_write: "read",
  write_file: "edit",
  edit_file: "edit",
  bash: "execute",
};
