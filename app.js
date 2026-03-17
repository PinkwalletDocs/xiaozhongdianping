const state = {
  currentRank: "top",
  votedAddresses: new Set(),
  kolData: [
    { id: "0xAres", uid: "@AresAlpha", followers: 182000, tag: "alpha", score: 4.6, votes: 328, risk: "安全", rank: "top", leadTrade: false },
    { id: "DeFiNing", uid: "@DeFiNing", followers: 94000, tag: "合约", score: 4.2, votes: 214, risk: "中风险", rank: "top", leadTrade: true },
    { id: "MemeDoctor", uid: "@MemeDoctor", followers: 261000, tag: "meme", score: 3.1, votes: 539, risk: "高风险", rank: "black", leadTrade: true },
    { id: "WhaleSignal", uid: "@WhaleSignal", followers: 143000, tag: "带单", score: 2.9, votes: 487, risk: "高风险", rank: "black", leadTrade: true },
    { id: "ChainPanda", uid: "@ChainPanda", followers: 27000, tag: "项目方", score: 4.5, votes: 89, risk: "中风险", rank: "new", leadTrade: false },
    { id: "YoloResearch", uid: "@YoloResearch", followers: 39000, tag: "alpha", score: 4.1, votes: 102, risk: "安全", rank: "new", leadTrade: false }
  ],
  blackFeed: [
    "WhaleSignal：2小时内连续改口，社区争议很大（证据：tx#9a7...)",
    "MemeDoctor：历史喊单项目出现Rug记录（证据：截图上传）"
  ],
  alphaFeed: [
    "AresAlpha：提前48小时提示热点板块，命中率高",
    "ChainPanda：新品上线前给出清晰风险提醒"
  ],
  reports: [
    {
      twitterId: "@WhaleSignal",
      event: "宣传项目后24小时大跌，社区出现集中维权。",
      credibility: "存疑",
      evidence: ["tx_hash_0x91ac...", "price_screenshot.png"]
    }
  ]
};

const searchInput = document.getElementById("searchInput");
const kolList = document.getElementById("kolList");
const tabs = document.querySelectorAll(".tab");
const themeToggle = document.getElementById("themeToggle");
const kolSelect = document.getElementById("kolSelect");
const voteForm = document.getElementById("voteForm");
const voteTips = document.getElementById("voteTips");
const submitForm = document.getElementById("submitForm");
const submitMsg = document.getElementById("submitMsg");
const blackFeed = document.getElementById("blackFeed");
const alphaFeed = document.getElementById("alphaFeed");
const reportForm = document.getElementById("reportForm");
const reportMsg = document.getElementById("reportMsg");
const reportList = document.getElementById("reportList");
const moduleLinks = document.querySelectorAll(".module-link");
const moduleCards = document.querySelectorAll(".module-card");
const voteModal = document.getElementById("voteModal");
const voteModalForm = document.getElementById("voteModalForm");
const voteModalClose = document.getElementById("voteModalClose");
const modalKolName = document.getElementById("modalKolName");
const modalKolInput = document.getElementById("modalKolInput");
const modalWalletInput = document.getElementById("modalWalletInput");
const modalVoteTips = document.getElementById("modalVoteTips");

function formatFollowers(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

function getAvatarUrl(item) {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(item.id)}`;
}

function renderKols() {
  const query = searchInput.value.trim().toLowerCase();
  const list = state.kolData.filter((item) => {
    const rankMatch = item.rank === state.currentRank;
    const searchMatch = item.id.toLowerCase().includes(query) || item.uid.toLowerCase().includes(query);
    return rankMatch && searchMatch;
  });

  kolList.innerHTML = list
    .map((item) => {
      return `
      <article class="kol-item">
        <div class="kol-head">
          <img class="kol-avatar" src="${getAvatarUrl(item)}" alt="${item.id}头像" />
          <div>
            <h3>${item.id} <span class="badge">${item.tag}</span></h3>
            <p class="kol-rating">${item.score.toFixed(1)}分，${item.votes}人点评</p>
          </div>
        </div>
        <p>推特ID：${item.uid}</p>
        <p>粉丝：${formatFollowers(item.followers)}</p>
        <p>风险等级：${item.risk}</p>
        <button class="yellow-btn kol-vote-btn" type="button" data-kol-vote="${item.id}">投票</button>
      </article>`;
    })
    .join("");

  if (!list.length) {
    kolList.innerHTML = `<p class="muted">当前条件下没有匹配KOL。</p>`;
  }
}

function renderSelect() {
  kolSelect.innerHTML = state.kolData
    .map((item) => `<option value="${item.id}">${item.id} (${item.uid})</option>`)
    .join("");
}

function renderFeed() {
  blackFeed.innerHTML = state.blackFeed.map((item) => `<li>${item}</li>`).join("");
  alphaFeed.innerHTML = state.alphaFeed.map((item) => `<li>${item}</li>`).join("");
}

function credibilityClass(value) {
  if (value === "完全可信") return "credibility-true";
  if (value === "存疑") return "credibility-mid";
  return "credibility-false";
}

function renderReports() {
  reportList.innerHTML = state.reports
    .map((item) => {
      const files = item.evidence.length ? item.evidence.join(" / ") : "无";
      return `<li><strong>${item.twitterId}</strong>：${item.event}
      <span class="credibility-tag ${credibilityClass(item.credibility)}">${item.credibility}</span>
      <br />证据：${files}</li>`;
    })
    .join("");
}

function fakeHash() {
  return Math.random().toString(16).slice(2, 12).padEnd(10, "0");
}

function submitVote(wallet, selectedKol, scores, messageEl) {
  if (scores.some((score) => Number.isNaN(score) || score < 1 || score > 5)) {
    messageEl.textContent = "评分范围必须是1-5。";
    return false;
  }
  if (!wallet) {
    messageEl.textContent = "请输入钱包地址。";
    return false;
  }
  if (state.votedAddresses.has(wallet)) {
    messageEl.textContent = "该地址已投票，可后续开放修改并保留历史记录。";
    return false;
  }

  state.votedAddresses.add(wallet);
  const avg = scores.reduce((acc, val) => acc + val, 0) / scores.length;
  const target = state.kolData.find((item) => item.id === selectedKol);
  if (target) {
    target.score = (target.score * target.votes + avg) / (target.votes + 1);
    target.votes += 1;
  }
  renderKols();
  messageEl.textContent = `投票成功，存证Hash：0x${fakeHash()}（演示）`;
  return true;
}

function openVoteModal(kolId) {
  modalKolInput.value = kolId;
  modalKolName.textContent = `当前投票对象：${kolId}`;
  modalVoteTips.textContent = "";
  voteModalForm.reset();
  modalKolInput.value = kolId;
  voteModal.classList.add("open");
  voteModal.setAttribute("aria-hidden", "false");
  modalWalletInput.focus();
}

function closeVoteModal() {
  voteModal.classList.remove("open");
  voteModal.setAttribute("aria-hidden", "true");
}

function setActiveModule(moduleId) {
  moduleCards.forEach((card) => {
    card.classList.toggle("active", card.id === moduleId);
  });
  moduleLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.target === moduleId);
  });
}

function getHashModule() {
  const moduleId = window.location.hash.replace("#", "");
  const exists = Array.from(moduleCards).some((card) => card.id === moduleId);
  return exists ? moduleId : "kol";
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((it) => it.classList.remove("active"));
    tab.classList.add("active");
    state.currentRank = tab.dataset.rank;
    renderKols();
  });
});

searchInput.addEventListener("input", renderKols);

kolList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-kol-vote]");
  if (!button) return;
  openVoteModal(button.dataset.kolVote);
});

moduleLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const target = link.dataset.target;
    window.location.hash = target;
    setActiveModule(target);
  });
});

window.addEventListener("hashchange", () => {
  setActiveModule(getHashModule());
});

themeToggle.addEventListener("click", () => {
  document.body.classList.toggle("dark");
});

voteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const wallet = document.getElementById("walletInput").value.trim();
  const selectedKol = kolSelect.value;
  const form = new FormData(voteForm);
  const scores = ["trust", "alpha", "winRate", "risk"].map((key) => Number(form.get(key)));
  const success = submitVote(wallet, selectedKol, scores, voteTips);
  if (success) voteForm.reset();
});

voteModalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const wallet = modalWalletInput.value.trim();
  const selectedKol = modalKolInput.value;
  const form = new FormData(voteModalForm);
  const scores = ["trust", "alpha", "winRate", "risk"].map((key) => Number(form.get(key)));
  const success = submitVote(wallet, selectedKol, scores, modalVoteTips);
  if (success) {
    kolSelect.value = selectedKol;
    setTimeout(closeVoteModal, 500);
  }
});

voteModalClose.addEventListener("click", closeVoteModal);

voteModal.addEventListener("click", (event) => {
  if (event.target === voteModal) closeVoteModal();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && voteModal.classList.contains("open")) {
    closeVoteModal();
  }
});

submitForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const twitterLink = document.getElementById("twitterLink").value.trim();
  const desc = document.getElementById("kolDesc").value.trim();
  const tag = document.getElementById("kolTag").value;
  const isLeadTrade = document.getElementById("isLeadTrade").checked;
  submitMsg.textContent = `已提交审核：${twitterLink} | 标签：${tag} | 带单：${isLeadTrade ? "是" : "否"}。管理员审核后入库。`;
  if (desc.length > 0) {
    submitForm.reset();
  }
});

reportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const twitterId = document.getElementById("reportTwitterId").value.trim();
  const eventText = document.getElementById("reportEvent").value.trim();
  const credibility = document.getElementById("reportCredibility").value;
  const files = Array.from(document.getElementById("reportEvidence").files || []).map((file) => file.name);

  if (!twitterId || !eventText) {
    reportMsg.textContent = "请填写人物和事件内容。";
    return;
  }

  state.reports.unshift({
    twitterId,
    event: eventText,
    credibility,
    evidence: files
  });
  renderReports();
  reportForm.reset();
  reportMsg.textContent = "爆料已提交，已进入公示列表（演示环境）。";
});

renderSelect();
renderFeed();
renderReports();
renderKols();
setActiveModule(getHashModule());
