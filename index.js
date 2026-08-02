const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
  white: "\x1b[97m",
  cyan: "\x1b[96m",
  green: "\x1b[92m",
  red: "\x1b[91m",
  yellow: "\x1b[93m"
};

const INNER = 64;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function vlen(s) {
  return s.replace(ANSI_REGEX, '').length;
}

function getPad() {
  const cols = process.stdout.columns || 80;
  const padding = Math.max(0, Math.floor((cols - (INNER + 4)) / 2));
  return ' '.repeat(padding);
}

function top(fill = '─') {
  return `${getPad()}${C.dim}╭${fill.repeat(INNER + 2)}╮${C.reset}`;
}

function mid(fill = '─') {
  return `${getPad()}${C.dim}├${fill.repeat(INNER + 2)}┤${C.reset}`;
}

function bot(fill = '─') {
  return `${getPad()}${C.dim}╰${fill.repeat(INNER + 2)}╯${C.reset}`;
}

function row(text = "", indent = 1) {
  let pad = (INNER + 1) - indent - vlen(text);
  if (pad < 0) pad = 0;
  return `${getPad()}${C.dim}│${C.reset}${' '.repeat(indent)}${text}${' '.repeat(pad)} ${C.dim}│${C.reset}`;
}

function field(label, value, valueColor = "") {
  const labelPart = `${C.dim}${label.padEnd(12)}${C.reset}`;
  const valuePart = valueColor ? `${valueColor}${value}${C.reset}` : value;
  return row(`${labelPart}${valuePart}`);
}

function center(text) {
  const v = vlen(text);
  const left = Math.floor((INNER - v) / 2);
  const right = INNER - v - left;
  return `${getPad()}${C.dim}│${C.reset}${' '.repeat(left + 1)}${text}${' '.repeat(right + 1)}${C.dim}│${C.reset}`;
}

function printHeader(status = "IDLE") {
  console.clear();
  const statusColor = status === "RUNNING" ? C.green : C.red;

  console.log();
  console.log(top());
  console.log(center(`${C.bold}${C.white}PINTEREST SCRAPER${C.reset}`));
  console.log(center(`${C.dim}by github.com/FearsPalace${C.reset}`));
  console.log(mid());
  console.log(field("Status", `● ${status}`, statusColor));
  if (targetUsername) {
    console.log(field("Target", targetUsername, C.cyan));
  }
  console.log(bot());
  console.log();
}

function printMenu() {
  console.log(`${getPad()}  ${C.dim}MAIN MENU${C.reset}`);
  console.log(top());
  console.log(row(`${C.cyan}1${C.reset}  ${C.dim}·${C.reset}  Enter Username`));
  console.log(row(`${C.cyan}2${C.reset}  ${C.dim}·${C.reset}  Clear Console`));
  console.log(row(`${C.cyan}3${C.reset}  ${C.dim}·${C.reset}  Exit`));
  console.log(bot());
  console.log();
}

let targetUsername = null;
let currentBoards = [];
let currentUserData = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const defaultHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Accept": "application/json, text/javascript, */*, q=0.01",
  "X-Pinterest-AppState": "active",
};

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

function extractImageUrl(item) {
  if (item.type === 'explorearticle' && item.cover_images && item.cover_images.length > 0) {
    const cover = item.cover_images[0];
    return cover.originals?.url || cover.orig?.url || cover['1200x']?.url || cover['750x']?.url;
  }
  if (item.images?.orig?.url) return item.images.orig.url;
  if (item.images?.originals?.url) return item.images.originals.url;

  if (item.objects) {
    for (const obj of item.objects) {
      if (obj.cover_images && obj.cover_images.length > 0) {
        const cover = obj.cover_images[0];
        const url = cover.originals?.url || cover.orig?.url || cover['1200x']?.url || cover['750x']?.url;
        if (url) return url;
      }
    }
  }
  return null;
}

async function fetchUserProfile(username) {
  const dataParams = { options: { username: username, field_set_key: "profile" }, context: {} };
  const query = new URLSearchParams({ source_url: `/${username}/`, data: JSON.stringify(dataParams), _: Date.now() });
  const url = `https://www.pinterest.com/resource/UserResource/get/?${query.toString()}`;

  const headers = { ...defaultHeaders, "X-Pinterest-PWS-Handler": `www/[username].js` };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("Failed to fetch user profile");
  const json = await res.json();
  return json.resource_response?.data;
}

async function fetchUserBoards(username) {
  const dataParams = { options: { username: username, field_set_key: "detailed" }, context: {} };
  const query = new URLSearchParams({ source_url: `/${username}/`, data: JSON.stringify(dataParams), _: Date.now() });
  const url = `https://www.pinterest.com/resource/BoardsResource/get/?${query.toString()}`;

  const headers = { ...defaultHeaders, "X-Pinterest-PWS-Handler": `www/[username].js` };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("Failed to fetch boards");
  const json = await res.json();
  return json.resource_response?.data || [];
}

async function prepareUserScraping(inputStr) {
  printHeader("RUNNING");
  console.log(`${getPad()}  ${C.dim}Fetching data...${C.reset}\n`);

  if (inputStr.includes('pinterest.com') || inputStr.startsWith('http') || inputStr.includes('/')) {
    await scrapeMultiple([inputStr]);
    return;
  }

  targetUsername = inputStr.replace('@', '');

  try {
    const [user, boards] = await Promise.all([
      fetchUserProfile(targetUsername),
      fetchUserBoards(targetUsername)
    ]);

    if (!user) {
      console.log(`${getPad()}  ${C.red}X${C.reset}  User not found.`);
      targetUsername = null;
      setTimeout(promptMenu, 1500);
      return;
    }

    currentUserData = user;
    currentBoards = boards;

    showBoardSelection(new Set());
  } catch (e) {
    console.error(`${getPad()}  ${C.red}X${C.reset}  Error fetching user:`, e.message);
    targetUsername = null;
    setTimeout(promptMenu, 1500);
  }
}

function showBoardSelection(selectedIndices) {
  printHeader("IDLE");

  console.log(`${getPad()}  ${C.dim}USER DATA: ${targetUsername}${C.reset}`);
  console.log(top());

  const totalPins = currentUserData.pin_count || 0;

  const sel0 = selectedIndices.has(0) ? `${C.green}√${C.reset}` : `${C.red}X${C.reset}`;
  console.log(row(`[${sel0}] ${C.cyan}0${C.reset}  ${C.dim}·${C.reset}  _created (Created Pins)`));

  currentBoards.forEach((board, index) => {
    const idx = index + 1;
    let name = board.name;
    if (name.length > 25) name = name.substring(0, 22) + '...';

    const sel = selectedIndices.has(idx) ? `${C.green}√${C.reset}` : `${C.red}X${C.reset}`;
    console.log(row(`[${sel}] ${C.cyan}${idx}${C.reset}  ${C.dim}·${C.reset}  ${name.padEnd(26)} ${C.dim}(${board.pin_count} pins)${C.reset}`));
  });

  console.log(mid());
  console.log(row(`${C.cyan}C${C.reset}  ${C.dim}·${C.reset}  Continue & Start Scraping Selected`));
  console.log(bot());
  console.log();

  rl.question(`${getPad()}  Select an option to toggle or 'C' to continue  ${C.cyan}›${C.reset} `, (choice) => {
    choice = choice.trim().toLowerCase();

    if (choice === 'c') {
      if (selectedIndices.size === 0) {
        console.log(`${getPad()}  ${C.red}X${C.reset}  No boards selected!`);
        setTimeout(() => showBoardSelection(selectedIndices), 1000);
        return;
      }

      const targets = [];
      if (selectedIndices.has(0)) {
        targets.push(`https://www.pinterest.com/${targetUsername}/_created/`);
      }

      currentBoards.forEach((board, index) => {
        if (selectedIndices.has(index + 1)) {
          targets.push(`https://www.pinterest.com${board.url}`);
        }
      });

      scrapeMultiple(targets);

    } else {
      const idx = parseInt(choice, 10);
      if (!isNaN(idx) && idx >= 0 && idx <= currentBoards.length) {
        if (selectedIndices.has(idx)) {
          selectedIndices.delete(idx);
        } else {
          selectedIndices.add(idx);
        }
        showBoardSelection(selectedIndices);
      } else {
        console.log(`${getPad()}  ${C.red}X${C.reset}  Invalid option.`);
        setTimeout(() => showBoardSelection(selectedIndices), 1000);
      }
    }
  });
}

async function scrapeMultiple(targets) {
  printHeader("RUNNING");
  console.log(`${getPad()}  ${C.dim}Scraping ${targets.length} selected target(s)...${C.reset}\n`);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    console.log(`${getPad()}  ${C.dim}>>> Starting target ${i + 1}/${targets.length}: ${target}${C.reset}`);
    await startScraping(target);
    console.log();
  }

  rl.question(`\n${getPad()}  ${C.green}√${C.reset}  ${C.dim}All targets finished! Press Enter to return to menu${C.reset} `, () => {
    targetUsername = null;
    promptMenu();
  });
}

async function startScraping(boardUrlStr) {
  let urlObj;
  try {
    let finalUrl = boardUrlStr;
    if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl;
    urlObj = new URL(finalUrl);
  } catch (e) {
    console.error(`${getPad()}  ${C.red}X${C.reset}  Invalid URL format: ${boardUrlStr}`);
    return;
  }

  const pathParts = urlObj.pathname.split('/').filter(p => p);
  if (pathParts.length < 2) {
    console.error(`${getPad()}  ${C.red}X${C.reset}  Invalid URL. Should be like https://www.pinterest.com/username/boardname/ or /_created/`);
    return;
  }

  const username = pathParts[0];
  const slug = pathParts[1];
  const sourceUrl = `/${username}/${slug}/`;
  const isCreatedTab = slug === '_created';

  const headers = {
    ...defaultHeaders,
    "X-Pinterest-PWS-Handler": `www/[username]/[slug].js`,
  };

  async function fetchBoardId() {
    const dataParams = { options: { username: username, slug: slug, field_set_key: "detailed" }, context: {} };
    const query = new URLSearchParams({ source_url: sourceUrl, data: JSON.stringify(dataParams), _: Date.now() });
    const url = `https://www.pinterest.com/resource/BoardResource/get/?${query.toString()}`;

    console.log(`${getPad()}  ${C.dim}·${C.reset}  Fetching board info...`);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Failed to fetch board: ${res.statusText}`);
    const json = await res.json();
    if (json.resource_response?.data?.id) return json.resource_response.data.id;
    throw new Error("Could not find board ID in response");
  }

  async function fetchPins(boardId, bookmark) {
    const dataParams = isCreatedTab ? {
      options: { username: username, is_own_profile_pins: false, bookmarks: bookmark ? [bookmark] : [] },
      context: {}
    } : {
      options: { board_id: boardId, board_url: sourceUrl, currentFilter: -1, field_set_key: "react_grid_pin", filter_section_pins: true, sort: "default", layout: "default", page_size: 25, redux_normalize_feed: true, bookmarks: bookmark ? [bookmark] : [] },
      context: {}
    };

    const query = new URLSearchParams({ source_url: sourceUrl, data: JSON.stringify(dataParams), _: Date.now() });
    const resourceName = isCreatedTab ? 'UserPinsResource' : 'BoardFeedResource';
    const url = `https://www.pinterest.com/resource/${resourceName}/get/?${query.toString()}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Failed to fetch pins: ${res.statusText}`);
    return (await res.json()).resource_response;
  }

  try {
    let boardId = null;
    if (!isCreatedTab) {
      boardId = await fetchBoardId();
      console.log(`${getPad()}  ${C.green}√${C.reset}  Found Board ID: ${C.cyan}${boardId}${C.reset}`);
    } else {
      console.log(`${getPad()}  ${C.dim}·${C.reset}  Scraping created pins for user: ${C.cyan}${username}${C.reset}`);
    }

    let hasNext = true;
    let bookmark = null;
    let imageCount = 0;

    const outputDir = path.join(__dirname, username, slug);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const processedUrls = new Set();

    while (hasNext) {
      console.log(`${getPad()}  ${C.dim}·${C.reset}  Fetching pins (bookmark: ${bookmark ? bookmark.substring(0, 15) + '...' : 'initial'})...`);
      const response = await fetchPins(boardId, bookmark);

      const data = response.data || [];
      const options = response.options || (response.resource ? response.resource.options : null);
      const newBookmark = response.bookmark || (options?.bookmarks ? options.bookmarks[0] : null);

      let foundImages = 0;
      for (const item of data) {
        const imageUrl = extractImageUrl(item);
        if (imageUrl) {
          if (processedUrls.has(imageUrl)) continue;
          processedUrls.add(imageUrl);

          foundImages++;
          imageCount++;
          const filename = path.basename(new URL(imageUrl).pathname);
          const dest = path.join(outputDir, filename);

          if (!fs.existsSync(dest)) {
            try {
              await downloadImage(imageUrl, dest);
            } catch (err) {
              console.error(`${getPad()}  ${C.red}X${C.reset}  Failed to download ${filename}:`, err.message);
            }
          }
        }
      }

      console.log(`${getPad()}  ${C.green}√${C.reset}  Processed ${foundImages} images in this batch.`);

      if (newBookmark && newBookmark !== '-end-' && data.length > 0) {
        bookmark = newBookmark;
      } else {
        hasNext = false;
      }
    }

    console.log(`${getPad()}  ${C.green}√${C.reset}  ${C.bold}Finished!${C.reset} Downloaded ${imageCount} unique images to /${username}/${slug}`);

  } catch (error) {
    console.error(`${getPad()}  ${C.red}X${C.reset}  Error:`, error.message);
  }
}

function promptMenu() {
  printHeader();
  printMenu();
  rl.question(`${getPad()}  Select an option  ${C.cyan}›${C.reset} `, (choice) => {
    handleChoice(choice.trim());
  });
}

function handleChoice(choice) {
  if (choice === '1') {
    rl.question(`${getPad()}  Enter Username  ${C.cyan}›${C.reset} `, (inputStr) => {
      if (inputStr.trim()) {
        prepareUserScraping(inputStr.trim());
      } else {
        promptMenu();
      }
    });
  } else if (choice === '2') {
    promptMenu();
  } else if (choice === '3') {
    console.log(`${getPad()}  ${C.dim}Exiting...${C.reset}`);
    rl.close();
  } else {
    console.log(`${getPad()}  ${C.red}X${C.reset}  Invalid option`);
    setTimeout(promptMenu, 1000);
  }
}

const initialArgs = process.argv.slice(2);
if (initialArgs.length > 0) {
  prepareUserScraping(initialArgs[0]);
} else {
  promptMenu();
}
