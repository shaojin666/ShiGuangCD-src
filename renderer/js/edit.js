'use strict';
/* ============================================================
   edit.js —— 手动编辑专辑信息与歌词（仅保存在本地）
   ------------------------------------------------------------
   歌词区三件事：
     1) 歌词源管理：展示降级链抓到的**全部**候选（tr.lyricsSources），
        点哪行用哪个平台的歌词（IPC lyrics:select-source）；
     2) 手动添加：粘贴 TTML XML 保存（lyrics:add-ttml）——
        某个源没收录这首歌时，用户在 AMLL TTML Tool 自己打好轴复制进来；
     3) 手动编辑：经典 LRC 文本框（旧行为，改过即丢弃结构化模型）。
   ============================================================ */

const Edit = (() => {
  const el = document.getElementById('overlay-edit');

  /** AMLL TTML Tool 在线版（ITManCHINA 维护的镜像，GitHub Pages 原站已下线）。
   *  仓库：https://github.com/ITManCHINA/amll-ttml-tool */
  const TTML_TOOL_URL = 'https://amll-ttml-tool.stevexmh.net/';

  /** 当前面板编辑的元数据（选源/贴 TTML 后会换成主进程回传的最新版） */
  let currentMeta = null;

  /** 候选源显示名（source 字段 → 人话） */
  const SRC_LABELS = {
    amll: 'AMLL TTML',
    netease: 'edit.src.netease',
    qq: 'edit.src.qq',
    kugou: 'edit.src.kugou',
    lrclib: 'LRCLIB',
    'ttml-manual': 'edit.src.manualTtml'
  };

  /** 来源名：映射表里是 i18n 键，纯 ASCII 品牌名（AMLL / LRCLIB）原样输出 */
  function srcBaseName(m) {
    const raw = m && m.source;
    const mapped = SRC_LABELS[raw];
    if (!mapped) return raw || T('edit.src.unknown');
    return mapped.indexOf('edit.') === 0 ? T(mapped) : mapped;
  }

  function srcLabel(m) {
    return srcBaseName(m) + T(m && m.isWordByWord ? 'edit.src.wordByWord' : 'edit.src.lineByLine');
  }

  /** 候选的附加标记：译 / 音 / 对唱 / 间奏×n（与主进程 won() 日志同口径） */
  function srcTags(m) {
    const tags = [];
    const lines = (m && m.lines) || [];
    if (lines.some((l) => l && l.tr)) tags.push(T('edit.src.tagTr'));
    if (lines.some((l) => l && l.ro)) tags.push(T('edit.src.tagRo'));
    if (lines.some((l) => l && l.bg && l.bg.length)) tags.push(T('edit.src.tagDuet'));
    const inst = lines.filter((l) => l && l.instrumental).length;
    if (inst) tags.push(T('edit.src.tagInst', { n: inst }));
    return tags;
  }

  /** 判断候选 m 是否为当前启用项（与主进程 sameModel 同口径：源+行数+首行时间） */
  function isActive(m, data) {
    if (!m || !data || !Array.isArray(m.lines) || !Array.isArray(data.lines)) return false;
    if (String(m.source) !== String(data.source)) return false;
    if (m.lines.length !== data.lines.length) return false;
    const a = m.lines[0] && m.lines[0].t;
    const b = data.lines[0] && data.lines[0].t;
    return a === b;
  }

  /**
   * 打开编辑面板。
   * @param {string} [sig] 指定要编辑的光盘指纹（音乐库右键编辑用）。
   *                       不传则编辑当前光驱里的那张盘。
   *   即使光盘没有插入，也可以编辑本地已保存的元数据。
   */
  async function open(sig) {
    let meta = null;
    if (sig) {
      try { meta = await window.cd.invoke('meta:get', sig); } catch (e) { meta = null; }
    } else {
      meta = App.state.metadata;
    }
    if (!meta || !meta.tracks || !meta.tracks.length) {
      Toast(T('edit.toast.none'));
      return;
    }
    currentMeta = meta;
    buildPanel(meta);
  }

  function buildPanel(meta) {
    el.innerHTML = '';
    el.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'panel';

    const head = document.createElement('div');
    head.className = 'panel-head';
    const titleBox = document.createElement('div');
    titleBox.className = 'panel-title-wrap';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = T('edit.title');
    titleBox.appendChild(title);
    // 「已编辑」标记放在编辑菜单内部，音乐库页面不再显示
    if (meta.manual) {
      const badge = document.createElement('span');
      badge.className = 'panel-badge';
      badge.title = T('edit.badge.editedTip');
      badge.textContent = T('edit.badge.edited');
      titleBox.appendChild(badge);
    }
    if (meta.signature && meta.signature !== App.state.signature) {
      const off = document.createElement('span');
      off.className = 'panel-badge ghost';
      off.title = T('edit.badge.offlineTip');
      off.textContent = T('edit.badge.offline');
      titleBox.appendChild(off);
    }
    const close = document.createElement('button');
    close.className = 'panel-close';
    close.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', closePanel);
    head.appendChild(titleBox);
    head.appendChild(close);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'panel-body';

    // 基础字段
    body.appendChild(field(T('edit.field.album'), 'edit-album', 'text', meta.album || ''));
    const row = document.createElement('div');
    row.className = 'field-row';
    row.appendChild(field(T('edit.field.artist'), 'edit-artist', 'text', meta.artist || ''));
    row.appendChild(field(T('edit.field.year'), 'edit-year', 'text', meta.year ? String(meta.year) : ''));
    body.appendChild(row);

    /**
     * ★ 碟号字段。
     *
     * CD 的 TOC 里没有碟号，软件只能从在线源推断（多为网易云的 cd 字段 /
     * MusicBrainz 的 medium position）。推断不一定准，尤其是：
     *   - 用户先放的是 disc2 再放 disc1；
     *   - 在线源把多碟合成了一个条目不标碟号。
     * 所以这里提供一个**可编辑、默认填检测值**的入口 ——
     * 用户一眼就能看出软件认成了第几张碟，不对就地改。
     *
     * 碟号参与元数据匹配：改了它再"重新获取在线信息"，
     * 就能按正确的碟去切分曲目与歌词，从根上避免多碟串味。
     */
    const discRow = document.createElement('div');
    discRow.className = 'field-row';
    const discField = field(T('edit.field.disc'), 'edit-disc', 'text',
      meta.discNumber ? String(meta.discNumber) : '1');
    discField.querySelector('input').placeholder = T('edit.field.discPlaceholder');
    discField.querySelector('input').inputMode = 'numeric';
    const discTotalField = field(T('edit.field.discTotal'), 'edit-disc-total', 'text',
      meta.discTotal ? String(meta.discTotal) : '');
    discTotalField.querySelector('input').placeholder = T('edit.field.discTotalPlaceholder');
    discTotalField.querySelector('input').inputMode = 'numeric';
    discRow.appendChild(discField);
    discRow.appendChild(discTotalField);
    body.appendChild(discRow);

    // 多碟专辑的提示：让用户明确知道碟号会影响匹配
    if (meta.discTotal && Number(meta.discTotal) > 1) {
      const discHint = document.createElement('div');
      discHint.className = 'field-hint';
      discHint.textContent = T('edit.discHint', { n: meta.discTotal });
      body.appendChild(discHint);
    }

    /**
     * ★ 专辑介绍 / 歌手介绍（v10.4）。
     * 在线抓取时会尽量填上（网易云专辑简介 / 歌手简介），这里允许手改；
     * 留空表示"没有介绍"，专辑详情页据此隐藏对应区块。
     * 用 textarea：介绍动辄几百字，单行 input 没法看全。
     */
    const introRow = document.createElement('div');
    introRow.className = 'field-row';
    introRow.appendChild(textField(T('edit.field.albumIntro'), 'edit-album-intro', meta.albumIntro || ''));
    introRow.appendChild(textField(T('edit.field.artistIntro'), 'edit-artist-intro', meta.artistIntro || ''));
    body.appendChild(introRow);

    // 封面
    const coverField = document.createElement('div');
    coverField.className = 'field';
    const coverLabel = document.createElement('div');
    coverLabel.className = 'field-label';
    coverLabel.textContent = T('edit.field.cover');
    const coverRow = document.createElement('div');
    coverRow.className = 'cover-upload';
    const thumb = document.createElement('div');
    thumb.className = 'cover-thumb';
    const img = document.createElement('img');
    img.alt = '';
    if (meta.hasCover) img.src = `cover://${encodeURIComponent(meta.signature)}/`;
    thumb.appendChild(img);
    const btnUpload = document.createElement('button');
    btnUpload.className = 'btn';
    btnUpload.textContent = T('edit.field.chooseImage');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result);
        const saved = await window.cd.invoke('meta:save-cover', { sig: meta.signature, dataUrl });
        // 关键：保存成功后用返回值刷新本地元数据，否则 App.state.metadata.hasCover
        // 仍为 false，正在播放页/音乐库不会显示刚上传的封面（读盘动画因重新读取 store 才显示）
        if (saved) {
          if (App.state.metadata && App.state.metadata.signature === saved.signature) {
            App.state.metadata = saved;
            NowPlaying.setDisc(saved);
          }
          Library.refresh();
        }
        img.src = dataUrl;
        Toast(T('edit.field.coverUpdated'));
      };
      reader.readAsDataURL(f);
    });
    coverRow.appendChild(thumb);
    coverRow.appendChild(btnUpload);
    coverRow.appendChild(fileInput);
    coverField.appendChild(coverLabel);
    coverField.appendChild(coverRow);
    body.appendChild(coverField);

    // 轨道
    const trackLabel = document.createElement('div');
    trackLabel.className = 'field-label';
    trackLabel.textContent = T('edit.tracks.label');
    body.appendChild(trackLabel);

    for (const tr of meta.tracks || []) {
      body.appendChild(buildTrack(meta, tr));
    }

    panel.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'panel-foot';
    const isCurrent = !!(meta.signature && meta.signature === App.state.signature);
    if (isCurrent) {
      /**
       * 在线信息获取区。
       *
       * 为什么需要两个按钮：
       *   - 「重新获取」：不带关键词，老老实实按光盘 TOC 指纹去 MusicBrainz 精确匹配。
       *     适合正版、常见的外语碟。
       *   - 「按关键词搜索」：用户自己填专辑名/歌手，直接走网易云。
       *     这是**华语碟、翻录碟、冷门碟的唯一可行路径**——
       *     它们大多在 MusicBrainz 里没有对应 DiscID，纯靠 TOC 是查不到的。
       *     这也是新方案里专门为大区用户补上的兜底入口。
       */
      const searchWrap = document.createElement('div');
      searchWrap.className = 'meta-search';
      const kwHint = document.createElement('div');
      kwHint.className = 'field-label';
      kwHint.textContent = T('edit.online.label');
      const kwRow = document.createElement('div');
      kwRow.className = 'meta-search-row';
      const kwAlbum = document.createElement('input');
      kwAlbum.type = 'text';
      kwAlbum.placeholder = T('edit.online.album');
      kwAlbum.value = meta.album || '';
      const kwArtist = document.createElement('input');
      kwArtist.type = 'text';
      kwArtist.placeholder = T('edit.online.artist');
      kwArtist.value = meta.artist || '';
      kwRow.appendChild(kwAlbum);
      kwRow.appendChild(kwArtist);
      searchWrap.appendChild(kwHint);
      searchWrap.appendChild(kwRow);

      const btnRow = document.createElement('div');
      btnRow.className = 'meta-search-row';

      const refetch = document.createElement('button');
      refetch.className = 'btn ghost';
      refetch.textContent = T('edit.online.refetch');
      refetch.title = T('edit.online.refetchTip');
      refetch.addEventListener('click', async () => {
        refetch.disabled = true;
        const old = refetch.textContent;
        refetch.textContent = T('edit.online.fetching');
        // 带上编辑框里的碟号，让指纹匹配在多碟发行里落到正确的碟
        const discInput = document.getElementById('edit-disc');
        const discTotalInput3 = document.getElementById('edit-disc-total');
        const hint = {};
        if (discInput && parseInt(discInput.value, 10) >= 1) hint.discNumber = parseInt(discInput.value, 10);
        if (discTotalInput3 && parseInt(discTotalInput3.value, 10) >= 1) hint.discTotal = parseInt(discTotalInput3.value, 10);
        await window.cd.invoke('cd:refetch-metadata', { hint });
        refetch.textContent = old;
        refetch.disabled = false;
        closePanel();
      });

      const searchByKw = document.createElement('button');
      searchByKw.className = 'btn accent';
      searchByKw.textContent = T('edit.online.search');
      searchByKw.title = T('edit.online.searchTip');
      searchByKw.addEventListener('click', async () => {
        const album = kwAlbum.value.trim();
        const artist = kwArtist.value.trim();
        if (!album && !artist) {
          Toast(T('edit.online.needKeyword'));
          return;
        }
        /**
         * ★ 把编辑框里的碟号一并作为 hint 传下去。
         * 这样用户发现"前几首对错了碟"时，只要把碟号改成正确的值再点搜索，
         * 抓取层就会按新碟号重新切分曲目与歌词，一次修好。
         */
        const discInput = document.getElementById('edit-disc');
        const discTotalInput2 = document.getElementById('edit-disc-total');
        const hint = { album, artist };
        if (discInput && parseInt(discInput.value, 10) >= 1) {
          hint.discNumber = parseInt(discInput.value, 10);
        }
        if (discTotalInput2 && parseInt(discTotalInput2.value, 10) >= 1) {
          hint.discTotal = parseInt(discTotalInput2.value, 10);
        }
        searchByKw.disabled = true;
        refetch.disabled = true;
        const old = searchByKw.textContent;
        searchByKw.textContent = T('edit.online.searching');
        const res = await window.cd.invoke('cd:refetch-metadata', { hint });
        searchByKw.textContent = old;
        searchByKw.disabled = false;
        refetch.disabled = false;
        if (res && res.ok === false) Toast(T('edit.online.notFound'));
        else Toast(T('edit.online.updated'));
        closePanel();
      });

      btnRow.appendChild(refetch);
      btnRow.appendChild(searchByKw);
      searchWrap.appendChild(btnRow);
      foot.appendChild(searchWrap);
    }
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    const cancel = document.createElement('button');
    cancel.className = 'btn ghost';
    cancel.textContent = T('common.cancel');
    cancel.addEventListener('click', closePanel);
    const save = document.createElement('button');
    save.className = 'btn accent';
    save.textContent = T('edit.save');
    save.addEventListener('click', () => saveData(meta));
    foot.appendChild(spacer);
    foot.appendChild(cancel);
    foot.appendChild(save);
    panel.appendChild(foot);

    el.appendChild(panel);
  }

  function field(label, id, type, value) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const l = document.createElement('div');
    l.className = 'field-label';
    l.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.id = id;
    input.value = value || '';
    wrap.appendChild(l);
    wrap.appendChild(input);
    return wrap;
  }

  /** 多行文本域（专辑/歌手介绍用） */
  function textField(label, id, value) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const l = document.createElement('div');
    l.className = 'field-label';
    l.textContent = label;
    const ta = document.createElement('textarea');
    ta.id = id;
    ta.className = 'intro-input';
    ta.rows = 4;
    ta.value = value || '';
    ta.placeholder = T('edit.field.introPlaceholder');
    wrap.appendChild(l);
    wrap.appendChild(ta);
    return wrap;
  }

  function buildTrack(meta, tr) {
    const wrap = document.createElement('div');
    wrap.className = 'etrack';
    wrap.dataset.number = String(tr.number);

    const head = document.createElement('div');
    head.className = 'etrack-head';
    const num = document.createElement('div');
    num.className = 'etrack-num tabular';
    num.textContent = String(tr.number).padStart(2, '0');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'etrack-title';
    input.dataset.number = String(tr.number);
    input.value = tr.title || '';
    const toggle = document.createElement('button');
    toggle.className = 'etrack-toggle';
    toggle.textContent = T('edit.track.lyrics');
    // 有多个候选时在按钮上标个数，用户一眼知道"这张有几份歌词可挑"
    const nSrc = Array.isArray(tr.lyricsSources) ? tr.lyricsSources.length : 0;
    if (nSrc > 1) {
      const badge = document.createElement('span');
      badge.className = 'etrack-badge';
      badge.textContent = String(nSrc);
      badge.title = T('edit.track.srcCount', { n: nSrc });
      toggle.appendChild(badge);
    }
    head.appendChild(num);
    head.appendChild(input);
    head.appendChild(toggle);
    wrap.appendChild(head);

    const bodyBox = document.createElement('div');
    bodyBox.className = 'etrack-body hidden';

    /* ---------- 1) 歌词源管理 ---------- */
    bodyBox.appendChild(buildSources(meta, tr));

    /* ---------- 2) 粘贴 TTML ---------- */
    bodyBox.appendChild(buildTtmlBox(meta, tr));

    /* ---------- 3) 经典 LRC 手动编辑（旧行为） ---------- */
    const lrcLabel = document.createElement('div');
    lrcLabel.className = 'esrc-label';
    lrcLabel.textContent = T('edit.lrc.label');
    const ta = document.createElement('textarea');
    ta.className = 'lrc-input';
    ta.dataset.number = String(tr.number);
    ta.placeholder = T('edit.lrc.placeholder');
    ta.value = tr.lyrics || '';
    bodyBox.appendChild(lrcLabel);
    bodyBox.appendChild(ta);
    wrap.appendChild(bodyBox);

    toggle.addEventListener('click', () => {
      bodyBox.classList.toggle('hidden');
      toggle.classList.toggle('open');
    });
    return wrap;
  }

  /** 歌词源列表：点一行 = 启用该源（IPC lyrics:select-source） */
  function buildSources(meta, tr) {
    const box = document.createElement('div');
    box.className = 'esrc';
    const list = Array.isArray(tr.lyricsSources) ? tr.lyricsSources : [];

    const label = document.createElement('div');
    label.className = 'esrc-label';
    label.textContent = list.length
      ? T('edit.src.label', { n: list.length })
      : T('edit.src.labelEmpty');
    box.appendChild(label);

    if (!list.length) {
      const hint = document.createElement('div');
      hint.className = 'esrc-hint';
      hint.textContent = T('edit.src.emptyHint');
      box.appendChild(hint);
      return box;
    }

    const rows = document.createElement('div');
    rows.className = 'esrc-rows';
    list.forEach((m, i) => {
      if (!m) return;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'esrc-row' + (isActive(m, tr.lyricsData) ? ' on' : '');
      row.dataset.index = String(i);

      const radio = document.createElement('span');
      radio.className = 'esrc-radio';
      const name = document.createElement('span');
      name.className = 'esrc-name';
      name.textContent = srcLabel(m);
      const meta2 = document.createElement('span');
      meta2.className = 'esrc-meta tabular';
      const tags = srcTags(m);
      meta2.textContent = T('edit.src.meta', { n: (m.lines ? m.lines.length : 0), q: Math.round(m.quality || 0) })
        + (tags.length ? ' · ' + tags.join('/') : '');
      row.appendChild(radio);
      row.appendChild(name);
      row.appendChild(meta2);

      // 手动添加的候选才给删（在线抓来的删了下回还有，用户不想要选别的即可）
      if (m.source === 'ttml-manual') {
        const del = document.createElement('span');
        del.className = 'esrc-del';
        del.textContent = T('edit.src.del');
        del.title = T('edit.src.delTip');
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          del.disabled = true;
          // catch 必须带回消息：IPC 管道内部异常（落盘失败等）会 reject，
          // 早先 catch(() => null) 把真实原因吞了，用户只看到"未知错误"，
          // 排障时没有任何线索。
          const r = await window.cd.invoke('lyrics:remove-source', {
            sig: meta.signature, number: tr.number, index: i
          }).catch((e) => ({ ok: false, error: 'IPC: ' + (e && e.message ? e.message : e) }));
          if (r && r.ok && r.meta) {
            replaceMeta(r.meta);
            refreshTrack(r.meta, tr.number);
            Toast(T('edit.src.deleted'));
          } else {
            del.disabled = false;
            Toast(T('edit.src.deleteFail', { err: (r && r.error) || T('edit.error.unknown') }));
          }
        });
        row.appendChild(del);
      }

      row.addEventListener('click', async () => {
        if (row.classList.contains('on')) return; // 已启用
        const r = await window.cd.invoke('lyrics:select-source', {
          sig: meta.signature, number: tr.number, index: i
        }).catch((e) => ({ ok: false, error: 'IPC: ' + (e && e.message ? e.message : e) }));
        if (r && r.ok && r.meta) {
          replaceMeta(r.meta);
          refreshTrack(r.meta, tr.number);
          Toast(T('edit.src.switched', { name: srcLabel(m) }));
        } else {
          Toast(T('edit.src.switchFail', { err: (r && r.error) || T('edit.error.unknown') }));
        }
      });
      rows.appendChild(row);
    });
    box.appendChild(rows);
    return box;
  }

  /** TTML 粘贴区：AMLL TTML Tool 快捷按钮 + 粘贴框 + 保存 */
  function buildTtmlBox(meta, tr) {
    const box = document.createElement('div');
    box.className = 'esrc ttml-box';

    const label = document.createElement('div');
    label.className = 'esrc-label';
    label.textContent = T('edit.ttml.label');
    box.appendChild(label);

    const row = document.createElement('div');
    row.className = 'ttml-row';
    const openTool = document.createElement('button');
    openTool.type = 'button';
    openTool.className = 'btn ghost ttml-tool';
    openTool.textContent = T('edit.ttml.openTool');
    openTool.title = T('edit.ttml.openToolTip', { url: TTML_TOOL_URL });
    openTool.addEventListener('click', async () => {
      const ok = await window.cd.invoke('app:open-external', { url: TTML_TOOL_URL }).catch(() => false);
      if (!ok) Toast(T('edit.ttml.openFail', { url: TTML_TOOL_URL }));
    });
    const tip = document.createElement('span');
    tip.className = 'ttml-tip';
    tip.textContent = T('edit.ttml.tip');
    row.appendChild(openTool);
    row.appendChild(tip);
    box.appendChild(row);

    const ta = document.createElement('textarea');
    ta.className = 'ttml-input';
    ta.dataset.number = String(tr.number);
    ta.spellcheck = false;
    ta.placeholder = T('edit.ttml.placeholder');
    box.appendChild(ta);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn accent ttml-save';
    save.textContent = T('edit.ttml.save');
    save.addEventListener('click', async () => {
      const xml = ta.value;
      if (!xml || !xml.trim()) {
        Toast(T('edit.ttml.needContent'));
        return;
      }
      save.disabled = true;
      const old = save.textContent;
      save.textContent = T('edit.ttml.parsing');
      const r = await window.cd.invoke('lyrics:add-ttml', {
        sig: meta.signature, number: tr.number, ttml: xml
      }).catch((e) => ({ ok: false, error: 'IPC: ' + (e && e.message ? e.message : e) }));
      save.textContent = old;
      save.disabled = false;
      if (r && r.ok && r.meta) {
        replaceMeta(r.meta);
        refreshTrack(r.meta, tr.number);
        Toast(T(r.replaced ? 'edit.ttml.updated' : 'edit.ttml.saved'));
      } else {
        Toast(T('edit.ttml.saveFail', { err: ttmlErrText(r && r.error) }));
      }
    });
    box.appendChild(save);
    return box;
  }

  function ttmlErrText(err) {
    switch (err) {
      case 'empty': return T('edit.ttml.errEmpty');
      case 'not-ttml-or-empty': return T('edit.ttml.errInvalid');
      case 'track-not-found': return T('edit.ttml.errNoTrack');
      default: {
        const raw = String(err || T('edit.ttml.errUnknown'));
        return /^parse-failed:?\s*/.test(raw)
          ? T('edit.ttml.errParse', { err: raw.replace(/^parse-failed:?\s*/, '') })
          : raw;
      }
    }
  }

  /** 用主进程回传的最新元数据替换面板数据源（保存时以它为准） */
  function replaceMeta(meta) {
    currentMeta = meta;
    if (App.state.metadata && App.state.metadata.signature === meta.signature) {
      App.state.metadata = meta;
    }
  }

  /** 只重建某一轨的 DOM（选源/贴 TTML 后刷新，不整页重建） */
  function refreshTrack(meta, number) {
    const body = el.querySelector('.panel-body');
    if (!body) return;
    const tr = (meta.tracks || []).find((t) => Number(t.number) === Number(number));
    const old = el.querySelector('.etrack[data-number="' + number + '"]');
    if (!tr || !old) return;
    const fresh = buildTrack(meta, tr);
    // 保持展开态：用户正在这一轨里操作，不该被折叠回去
    // （querySelector 结果可能为 null——DOM 结构将来会变，别让刷新把成功切换炸成无声失败）
    const freshBody = fresh.querySelector('.etrack-body');
    const freshToggle = fresh.querySelector('.etrack-toggle');
    if (freshBody) freshBody.classList.remove('hidden');
    if (freshToggle) freshToggle.classList.add('open');
    old.replaceWith(fresh);
    // 当前播放页若正是这张盘，歌词视图跟着换源
    if (App.state.metadata && App.state.metadata.signature === meta.signature) {
      try { NowPlaying.setLyrics(meta, Number(number), true); } catch (e) { /* 忽略 */ }
    }
  }

  async function saveData(metaArg) {
    // 选源/贴 TTML 后 currentMeta 已被主进程回传的最新版替换，以它为准
    const meta = currentMeta || metaArg;
    const album = document.getElementById('edit-album');
    const artist = document.getElementById('edit-artist');
    const year = document.getElementById('edit-year');
    const disc = document.getElementById('edit-disc');
    const discTotalInput = document.getElementById('edit-disc-total');
    const introAlbum = document.getElementById('edit-album-intro');
    const introArtist = document.getElementById('edit-artist-intro');
    // 碟号：非法/留空一律归 1（与 schema 的 discNo 口径一致）
    const discNumber = disc && parseInt(disc.value, 10) >= 1 ? parseInt(disc.value, 10) : 1;
    const discTotalVal = discTotalInput && parseInt(discTotalInput.value, 10) >= 1
      ? parseInt(discTotalInput.value, 10) : null;
    const data = {
      album: album ? album.value.trim() : meta.album,
      artist: artist ? artist.value.trim() : meta.artist,
      albumIntro: introAlbum ? introAlbum.value.trim() : (meta.albumIntro || ''),
      artistIntro: introArtist ? introArtist.value.trim() : (meta.artistIntro || ''),
      year: year && year.value ? parseInt(year.value, 10) || null : null,
      discNumber,
      discTotal: discTotalVal,
      tracks: (meta.tracks || []).map((tr) => {
        const titleInput = el.querySelector(`.etrack-title[data-number="${tr.number}"]`);
        // ★ 只认 .lrc-input：TTML 粘贴框也是 textarea 且带同样的 data-number
        const lrcInput = el.querySelector(`.lrc-input[data-number="${tr.number}"]`);
        /*
         * 歌词被手动改过的轨：以 LRC 为准，丢掉逐字模型（lyricsData）与候选
         * 列表（lyricsSources）—— 否则统一模型仍按词级渲染，用户的修改
         * "看起来没生效"，候选列表也会指向一份和文本不符的旧数据。
         * 没碰歌词的轨：原样带回 lyricsData/lyricsSources —— 否则只改一个
         * 错别字，整张碟的逐字歌词都会退化成逐行（meta:save 是整体替换 tracks）。
         */
        const lyricsEdited = !!lrcInput && lrcInput.value !== (tr.lyrics || '');
        return {
          number: tr.number,
          title: titleInput ? titleInput.value.trim() : tr.title,
          artist: tr.artist || '',
          durationSec: tr.durationSec,
          lyrics: lrcInput ? lrcInput.value : tr.lyrics,
          lyricsSynced: lrcInput && lrcInput.value ? detectSynced(lrcInput.value) : tr.lyricsSynced,
          lyricsSource: tr.lyricsSource || null,
          lyricsData: lyricsEdited ? null : (tr.lyricsData || null),
          lyricsSources: lyricsEdited ? null : (tr.lyricsSources || null)
        };
      })
    };
    try {
      const saved = await window.cd.invoke('meta:save', { sig: meta.signature, data });
      if (saved) {
        // 只有编辑的正是当前这张盘时才覆盖界面状态；
        // 编辑的是音乐库里的历史记录时，当前播放页不能被动到
        if (App.state.metadata && App.state.metadata.signature === saved.signature) {
          App.state.metadata = saved;
          App.updateDiscViews();
        } else {
          Library.refresh();
        }
        Toast(T('edit.saved'));
      }
    } catch (e) {
      Toast(T('edit.saveFail', { err: e.message }));
    }
    currentMeta = null;
    closePanel();
  }

  function detectSynced(text) {
    return /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text);
  }

  function closePanel() {
    el.innerHTML = '';
    el.classList.add('hidden');
    currentMeta = null;
  }

  /** 面板是否开着 */
  function isOpen() {
    return !el.classList.contains('hidden');
  }

  /**
   * 语言切换后重建面板（v10.11）。
   * 用 currentMeta 直接重跑 buildPanel —— 不走 open()，
   * 避免再发一次 meta:get IPC，也保住用户已输入但未保存的内容？
   * 不会保住：buildPanel 是按元数据重建 DOM 的。改语言属于显式操作，
   * 这里接受"未保存的输入丢失"，与切页行为一致。
   */
  function refresh() {
    if (!isOpen() || !currentMeta) return;
    buildPanel(currentMeta);
  }

  return { open, close: closePanel, refresh, isOpen };
})();
