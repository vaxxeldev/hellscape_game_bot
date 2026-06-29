import subprocess
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NPM = "npm.cmd" if os.name == "nt" else "npm"


def test_user_name_formatting_for_tops_and_mentions():
    subprocess.run([NPM, "run", "build"], cwd=ROOT, check=True, text=True, capture_output=True)

    script = r"""
import assert from "node:assert/strict";
import { mentionUser, topUserName, userDisplayName, usernameOrName } from "./dist/utils/text.js";

const usernameUser = {
  telegram_id: 1001,
  username: "very_long_username_that_should_be_shortened_in_top_rows",
  first_name: "First",
  last_name: "Last",
};

const namelessUser = {
  telegram_id: 1002,
  username: null,
  first_name: "<First&Name>",
  last_name: "Last",
};

assert.equal(usernameOrName(usernameUser), "@very_long_username_that_should_be_shortened_in_top_rows");
assert.equal(userDisplayName(usernameUser), "very_long_username_that_should_be_shortened_in_top_rows");

const topName = topUserName(usernameUser, 18);
assert.equal(topName, "very_long_usern...");
assert.equal(topName.includes("@"), false);
assert.equal(topName.includes("href="), false);

assert.equal(topUserName(namelessUser), "&lt;First&amp;Name&gt; Last");
assert.equal(mentionUser(namelessUser), '<a href="tg://user?id=1002">&lt;First&amp;Name&gt; Last</a>');
"""
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True, text=True, capture_output=True)
