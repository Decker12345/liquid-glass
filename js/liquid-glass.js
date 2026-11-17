/*!
 * liquid-glass-kit v1.0.0 · JS 折射引擎
 * 作用：为 .lg 元素生成「圆角矩形 SDF 位移图」并注入 SVG 滤镜，
 *      通过 backdrop-filter: url(#id) 把元素背后的实时画面按位移图扭曲，
 *      得到真正的玻璃折射（含轻微色散）。
 *
 * 不加载本文件时，CSS 会给纯模糊版本 —— 也就是天然降级。
 *
 * API:
 *   LiquidGlass.supported            // 当前浏览器是否支持真折射
 *   LiquidGlass.init(options?)       // 手动初始化（自动初始化时会调用）
 *   LiquidGlass.scan(root?)          // 扫描并挂载新插入的 .lg
 *   LiquidGlass.refresh(el?)         // 重新测量尺寸并重建
 *   LiquidGlass.set({refract, dispersion, bezel})
 *   LiquidGlass.destroy(el)
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.LiquidGlass = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	var SVGNS = 'http://www.w3.org/2000/svg';
	var XLINKNS = 'http://www.w3.org/1999/xlink';

	/* ---------------- 全局参数 ---------------- */
	var params = {
		refract: 70,        // 0~150 折射强度（百分比）
		dispersion: true,   // 色散（RGB 三通道不同位移）
		bezel: 0.15,        // 倒角带宽占短边比例
		enabled: true       // 总开关，false 时全部退回纯模糊
	};

	var uid = 0;
	var defs = null;
	var filterCache = new Map();  // key: w x h x r x bezel -> entry
	var mapCache = new Map();     // key: 同上 -> { dataURL, scale }
	var handles = new Set();
	var started = false;

	/* ---------------- 能力探测 ----------------
	   backdrop-filter: url(#svgFilter) 目前只有 Chromium 系可用；
	   Safari / Firefox / iOS 全部内核都不支持，走纯模糊降级。 */
	var supported = (function () {
		if (typeof CSS === 'undefined' || !CSS.supports) return false;
		var hasBackdrop =
			CSS.supports('backdrop-filter', 'blur(2px)') ||
			CSS.supports('-webkit-backdrop-filter', 'blur(2px)');
		if (!hasBackdrop) return false;
		var ua = navigator.userAgent || '';
		var isIOS = /iPad|iPhone|iPod/.test(ua) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		var isFirefox = /Firefox|FxiOS/i.test(ua);
		var isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/i.test(ua);
		if (isIOS || isFirefox || isSafari) return false;
		return CSS.supports('backdrop-filter', 'url(#a)');
	})();

	/* ---------------- 工具 ---------------- */
	function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

	function ensureDefs() {
		if (defs) return defs;
		defs = document.createElementNS(SVGNS, 'svg');
		defs.setAttribute('class', 'lg-defs');
		defs.setAttribute('aria-hidden', 'true');
		defs.setAttribute('focusable', 'false');
		defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
		document.body.appendChild(defs);
		return defs;
	}

	/* =========================================================
	     位移图生成
	     圆角矩形 SDF 描述玻璃外形；沿法线向内采样，位移在倒角带内
	     呈 sin 钟形（两端为 0，中段峰值），因此玻璃内部完全不变形，
	     只有边缘一圈被"掰弯"—— 这正是真实玻璃厚边的视觉效果。
	     ========================================================= */
	function makeMap(w, h, radius, bezel) {
		var RES = 512;   // 位移图长边分辨率：元素小于 512px 时按 1:1 生成，避免放大后位移场被量化出台阶
		var s = Math.min(1, RES / Math.max(w, h));
		var mw = Math.max(24, Math.round(w * s));
		var mh = Math.max(24, Math.round(h * s));
		var r = Math.min(radius, w / 2, h / 2) * s;
		var hw = mw / 2, hh = mh / 2;
		var bez = Math.max(3, Math.min(w, h) * (bezel || 0.17)) * s;

		function sdf(x, y) {
			var qx = Math.abs(x) - hw + r;
			var qy = Math.abs(y) - hh + r;
			var ax = Math.max(qx, 0), ay = Math.max(qy, 0);
			return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
		}

		var data = new Uint8ClampedArray(mw * mh * 4);
		var offs = new Float32Array(mw * mh * 2);
		var maxOff = 0;
		var e = 0.7;

		for (var py = 0; py < mh; py++) {
			for (var px = 0; px < mw; px++) {
				var x = px + 0.5 - hw, y = py + 0.5 - hh;
				var d = sdf(x, y);
				var t = clamp(-d / bez, 0, 1);
				var bell = Math.sin(t * Math.PI);
				var dx = 0, dy = 0;
				if (bell > 1e-4) {
					var gx = sdf(x + e, y) - sdf(x - e, y);
					var gy = sdf(x, y + e) - sdf(x, y - e);
					var gl = Math.hypot(gx, gy);
					if (gl > 1e-6) {
						dx = (-gx / gl) * bell * bez;
						dy = (-gy / gl) * bell * bez;
					}
				}
				var i = (py * mw + px) * 2;
				offs[i] = dx; offs[i + 1] = dy;
				var m = Math.max(Math.abs(dx), Math.abs(dy));
				if (m > maxOff) maxOff = m;
			}
		}

		var k = maxOff > 1e-6 ? 127 / maxOff : 0;
		for (var p = 0; p < mw * mh; p++) {
			var q = p * 4;
			data[q] = 128 + offs[p * 2] * k;
			data[q + 1] = 128 + offs[p * 2 + 1] * k;
			data[q + 2] = 128;
			data[q + 3] = 255;
		}
		var cnv = document.createElement('canvas');
		cnv.width = mw; cnv.height = mh;
		cnv.getContext('2d').putImageData(new ImageData(data, mw, mh), 0, 0);

		// feDisplacementMap 的位移 = scale * (channel/255 - .5)，峰值约 0.498
		return { dataURL: cnv.toDataURL(), scale: (maxOff / s) * 2 };
	}

	function getMap(w, h, radius, bezel) {
		var key = w + 'x' + h + 'x' + Math.round(radius) + 'x' + bezel.toFixed(3);
		var hit = mapCache.get(key);
		if (hit) return hit;
		var made = makeMap(w, h, radius, bezel);
		mapCache.set(key, made);
		return made;
	}

	/* =========================================================
	     滤镜构建
	     位移图 → R/G/B 三通道分别位移（不同 scale = 色散）→ screen 混合
	     ========================================================= */
	function buildFilter(w, h, radius, bezel) {
		var key = w + 'x' + h + 'x' + Math.round(radius) + 'x' + bezel.toFixed(3);
		var hit = filterCache.get(key);
		if (hit) return hit;

		var id = 'lg-f' + (++uid);
		var f = document.createElementNS(SVGNS, 'filter');
		f.setAttribute('id', id);
		f.setAttribute('filterUnits', 'userSpaceOnUse');
		f.setAttribute('color-interpolation-filters', 'sRGB');
		f.setAttribute('x', '0');
		f.setAttribute('y', '0');
		f.setAttribute('width', String(w));
		f.setAttribute('height', String(h));

		var map = getMap(w, h, radius, bezel);

		var img = document.createElementNS(SVGNS, 'feImage');
		img.setAttribute('x', '0');
		img.setAttribute('y', '0');
		img.setAttribute('width', String(w));
		img.setAttribute('height', String(h));
		img.setAttribute('preserveAspectRatio', 'none');
		img.setAttribute('result', 'map');
		img.setAttribute('href', map.dataURL);
		img.setAttributeNS(XLINKNS, 'xlink:href', map.dataURL);
		f.appendChild(img);

		var matrices = [
			'1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
			'0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
			'0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
		];
		var names = ['cR', 'cG', 'cB'];
		var disps = [];

		matrices.forEach(function (m, i) {
			var cm = document.createElementNS(SVGNS, 'feColorMatrix');
			cm.setAttribute('in', 'SourceGraphic');
			cm.setAttribute('type', 'matrix');
			cm.setAttribute('values', m);
			cm.setAttribute('result', names[i]);
			f.appendChild(cm);

			var dm = document.createElementNS(SVGNS, 'feDisplacementMap');
			dm.setAttribute('in', names[i]);
			dm.setAttribute('in2', 'map');
			dm.setAttribute('xChannelSelector', 'R');
			dm.setAttribute('yChannelSelector', 'G');
			dm.setAttribute('result', 'd' + i);
			dm.setAttribute('scale', '0');
			f.appendChild(dm);
			disps.push(dm);
		});

		var b1 = document.createElementNS(SVGNS, 'feBlend');
		b1.setAttribute('in', 'd0');
		b1.setAttribute('in2', 'd1');
		b1.setAttribute('mode', 'screen');
		b1.setAttribute('result', 'rg');
		f.appendChild(b1);

		var b2 = document.createElementNS(SVGNS, 'feBlend');
		b2.setAttribute('in', 'rg');
		b2.setAttribute('in2', 'd2');
		b2.setAttribute('mode', 'screen');
		f.appendChild(b2);

		ensureDefs().appendChild(f);

		var entry = { id: id, node: f, disps: disps, mapScale: map.scale, minDim: Math.min(w, h) };
		filterCache.set(key, entry);
		applyScale(entry);
		return entry;
	}

	/* 位移强度映射
	   直接拿位移图自身的 scale 做倍数会失控：大元素边缘被拉出十几像素、
	   小按钮整个糊成一团彩虹。这里改成「按元素短边自适应的绝对像素」：
	   峰值位移 = refract% × min(20, 短边 × 0.12)，再与位移图上限取小。
	   于是 100% 在 160px 高的卡片上 ≈ 9.5px，在 44px 按钮上 ≈ 2.3px。 */
	function applyScale(entry) {
		var on = params.enabled && params.refract > 0;
		var fit = Math.min(20, entry.minDim * 0.12);
		var desired = (params.refract / 100) * fit;
		var base = on ? Math.min(entry.mapScale, desired) : 0;
		var ratio = params.dispersion ? [1.04, 1.0, 0.96] : [1, 1, 1];
		entry.disps.forEach(function (dm, i) {
			dm.setAttribute('scale', (base * ratio[i]).toFixed(2));
		});
	}

	function applyAllScales() {
		filterCache.forEach(function (entry) { applyScale(entry); });
	}

	/* =========================================================
	     挂载 / 卸载
	     ========================================================= */
	function readRadius(el, w, h) {
		if (el.dataset.lgRadius) return parseFloat(el.dataset.lgRadius) || 0;
		var cs = getComputedStyle(el);
		var raw = cs.borderTopLeftRadius || '0';
		var v = parseFloat(raw) || 0;
		// 999px 这类胶囊值按短边一半算
		return Math.min(v, Math.min(w, h) / 2);
	}

	function readBezel(el) {
		if (el.dataset.lgBezel) {
			var b = parseFloat(el.dataset.lgBezel);
			if (isFinite(b)) return clamp(b, 0.02, 0.5);
		}
		return clamp(params.bezel, 0.02, 0.5);
	}

	function build(el) {
		var h = el.__lg;
		if (!h || h.destroyed) return;
		var w = Math.round(el.offsetWidth);
		var ht = Math.round(el.offsetHeight);
		if (!w || !ht) return;

		var radius = readRadius(el, w, ht);
		var bezel = readBezel(el);
		var key = w + 'x' + ht + 'x' + radius.toFixed(2) + 'x' + bezel.toFixed(3);
		if (h.key === key) return;
		h.key = key;
		h.w = w; h.h = ht;

		if (!params.enabled || !supported) {
			el.removeAttribute('data-lg-refract');
			el.style.removeProperty('--lg-filter');
			return;
		}

		var entry = buildFilter(w, ht, radius, bezel);
		el.style.setProperty('--lg-filter', 'url(#' + entry.id + ')');
		el.setAttribute('data-lg-refract', '');
	}

	function observe(el) {
		if (typeof ResizeObserver === 'undefined') return;
		var h = el.__lg;
		h.ro = new ResizeObserver(function () {
			if (h.timer) clearTimeout(h.timer);
			h.timer = setTimeout(function () {
				if (!h.destroyed) build(el);
			}, 140);
		});
		h.ro.observe(el);
	}

	/* 指针跟随高光：给玻璃加一层跟着鼠标走的反光 */
	function attachLight(el) {
		var h = el.__lg;
		var rect = null;
		var raf = 0;

		function onEnter() {
			rect = el.getBoundingClientRect();
			el.style.setProperty('--lg-light-a', '0.5');
		}
		function onMove(ev) {
			if (!rect) rect = el.getBoundingClientRect();
			var x = ev.clientX - rect.left;
			var y = ev.clientY - rect.top;
			if (raf) return;
			raf = requestAnimationFrame(function () {
				raf = 0;
				el.style.setProperty('--lg-mx', (x / rect.width * 100).toFixed(2) + '%');
				el.style.setProperty('--lg-my', (y / rect.height * 100).toFixed(2) + '%');
			});
		}
		function onLeave() {
			rect = null;
			el.style.setProperty('--lg-light-a', '0');
		}

		el.addEventListener('pointerenter', onEnter);
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerleave', onLeave);
		el.setAttribute('data-lg-light', '');

		h.lightOff = function () {
			el.removeEventListener('pointerenter', onEnter);
			el.removeEventListener('pointermove', onMove);
			el.removeEventListener('pointerleave', onLeave);
			el.style.removeProperty('--lg-light-a');
		};
	}

	function mount(el, opts) {
		opts = opts || {};
		if (el.__lg) return el.__lg;
		var h = { el: el, destroyed: false, key: '' };
		el.__lg = h;
		handles.add(h);

		build(el);
		observe(el);

		if (opts.light || el.hasAttribute('data-lg-light')) attachLight(el);
		return h;
	}

	function destroy(el) {
		var h = el && el.__lg;
		if (!h) return;
		h.destroyed = true;
		if (h.ro) h.ro.disconnect();
		if (h.timer) clearTimeout(h.timer);
		if (h.lightOff) h.lightOff();
		el.removeAttribute('data-lg-refract');
		el.style.removeProperty('--lg-filter');
		delete el.__lg;
		handles.delete(h);
	}

	function refresh(el) {
		if (el) { build(el); return; }
		handles.forEach(function (h) { if (!h.destroyed) build(h.el); });
	}

	/* =========================================================
	     扫描 / 初始化
	     ========================================================= */
	var SELECTOR = '.lg:not([data-lg="off"]), [data-lg]:not([data-lg="off"])';

	function scan(root) {
		root = root || document;
		var list = root.querySelectorAll ? root.querySelectorAll(SELECTOR) : [];
		Array.prototype.forEach.call(list, function (el) {
			if (!el.__lg) mount(el);
		});
	}

	function init(options) {
		if (options) set(options, true);
		if (typeof document === 'undefined') return;
		started = true;

		if (!document.body) {
			document.addEventListener('DOMContentLoaded', function () { init(); }, { once: true });
			return;
		}

		document.documentElement.classList.toggle('lg-no-refract', !supported || !params.enabled);
		scan(document);

		// 异步再扫一遍：等字体/图片把尺寸撑开后重新量一次
		window.addEventListener('load', function () { refresh(); }, { once: true });

		// 动态插入的元素
		if (typeof MutationObserver !== 'undefined') {
			var mo = new MutationObserver(function (muts) {
				muts.forEach(function (m) {
					Array.prototype.forEach.call(m.addedNodes || [], function (n) {
						if (n.nodeType !== 1) return;
						if (n.matches && n.matches(SELECTOR)) mount(n);
						if (n.querySelectorAll) scan(n);
					});
				});
			});
			mo.observe(document.body, { childList: true, subtree: true });
		}
	}

	/* =========================================================
	     参数
	     ========================================================= */
	function set(next, silent) {
		if (!next) return params;
		var bezelChanged = false;
		Object.keys(next).forEach(function (k) {
			if (!(k in params)) return;
			if (k === 'bezel' && next[k] !== params[k]) bezelChanged = true;
			params[k] = next[k];
		});

		if (typeof document === 'undefined') return params;
		document.documentElement.classList.toggle('lg-no-refract', !supported || !params.enabled);

		if (bezelChanged) {
			// 倒角宽度变了必须重建位移图与滤镜
			filterCache.forEach(function (e) { if (e.node.parentNode) e.node.parentNode.removeChild(e.node); });
			filterCache.clear();
			mapCache.clear();
			handles.forEach(function (h) { h.key = ''; });
		}
		applyAllScales();
		handles.forEach(function (h) {
			if (h.destroyed) return;
			if (!params.enabled) {
				h.el.removeAttribute('data-lg-refract');
				h.el.style.removeProperty('--lg-filter');
				h.key = '';
			} else {
				build(h.el);
			}
		});
		return params;
	}

	/* 自动初始化 */
	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', function () { init(); }, { once: true });
		} else {
			init();
		}
	}

	return {
		params: params,
		supported: supported,
		started: function () { return started; },
		init: init,
		scan: scan,
		mount: mount,
		destroy: destroy,
		refresh: refresh,
		set: set
	};
});
