// app.js - Adroit+ 智慧馬場雙效安防完全體 (修復優化版)
const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const statusBanner = document.getElementById('statusBanner');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const snapBtn = document.getElementById('snapBtn');

let session = null;
let isProcessing = false;
let logStep = 0; // 用於建立動態滾動日誌

const MODEL_WIDTH = 640;  
const MODEL_HEIGHT = 640; 

// 頂級科技感控制台
const logContainer = document.createElement('div');
logContainer.style = "position:fixed; top:75px; left:10px; width:220px; background:rgba(10,15,30,0.85); color:#00ffcc; font-family:monospace; font-size:10px; padding:10px; border-radius:8px; border:1px solid #00ffcc; z-index:999; pointer-events:none; line-height:1.5; box-shadow: 0 0 15px rgba(0,255,204,0.2);";
document.body.appendChild(logContainer);

function showDynamicLog(status, metrics = "") {
    const steps = [
        "🔄 [STREAM] 正在捕獲相機影格...",
        "🎨 [PRE] 執行 640x640 歸一化矩陣預處理...",
        "🧠 [INFERENCE] ONNX Engine 執行核心推理...",
        "📊 [POST] 解析 [1,84,8400] 輸出張量...",
        "🛡️ [SECURITY] 安全過濾防線布署中..."
    ];
    logStep = (logStep + 1) % steps.length;
    
    logContainer.innerHTML = `
<span style="color:#ffb703; font-weight:bold;">⚙️ ADROIT+ PIPELINE STATUS</span><br>
${steps[logStep]}<br>
<span style="color:#38bdf8;">⚡ 當前任務: ${status}</span><br>
${metrics}
    `.trim();
}

// 鎖定標準 [1, 84, 8400] 矩陣中的核心目標
const TARGET_CLASSES = {
    17: { en: 'Horse', zh: '馬匹', color: '#ef233c' },     // 馬：危險闖入目標 (改為科技紅框)
    2:  { en: 'Car', zh: '管制車輛', color: '#38bdf8' },   // 汽車：藍框
    3:  { en: 'Motorcycle', zh: '管制車輛', color: '#38bdf8' }, // 機車
    5:  { en: 'Bus', zh: '管制車輛', color: '#38bdf8' },  // 巴士
    7:  { en: 'Truck', zh: '管制車輛', color: '#38bdf8' }  // 卡車
};

async function init() {
    showDynamicLog("正在加載專屬晶片大腦...");
    try {
        session = await ort.InferenceSession.create('./best.onnx', { executionProviders: ['webgl', 'wasm'] });
        showDynamicLog("大腦晶片就緒", "• Model: YOLOv8-Nano-Joint<br>• Dimension: [1,84,8400]");
        setupCamera();
    } catch (e) {
        logContainer.innerHTML = `<span style="color:#ef233c;">❌ 載入失敗: ${e.message}</span>`;
    }
}

function setupCamera() {
    navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
    })
    .then((stream) => {
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            setInterval(processFrame, 66); // 優化頻率：一秒跑 15 次，兼顧手機散熱與即時安防
        });
    })
    .catch((err) => { logContainer.innerHTML = `❌ 相機權限錯誤`; });
}

async function processFrame() {
    if (video.paused || video.ended || isProcessing || !session) return;
    isProcessing = true;
    const t0 = performance.now();

    try {
        const tensorInput = preprocess(video, MODEL_WIDTH, MODEL_HEIGHT);
        const feeds = {};
        feeds[session.inputNames[0]] = tensorInput;
        
        const outputMap = await session.run(feeds);
        const outputTensor = outputMap[session.outputNames[0]];
        
        // 核心解包
        const { allDetections, filteredRender } = postprocess(outputTensor.data, outputTensor.dims);
        const totalTime = Math.round(performance.now() - t0);

        // 刷新黑客流實時日誌
        showDynamicLog(
            allDetections.length > 0 ? "🎯 目標鎖定中" : "🔍 監控範圍安全",
            `• 晶片推理耗時: <span style="color:#00ffcc;font-weight:bold;">${totalTime}ms</span><br>` +
            `• 全局動態速率: 30 FPS 流暢<br>` +
            `• 視野內潛在物件: ${allDetections.length} 個`
        );

        renderDetections(filteredRender, allDetections, totalTime);
    } catch (error) { console.error(error); }
    isProcessing = false;
}

function preprocess(videoElement, width, height) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width; tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(videoElement, 0, 0, width, height);
    const imgData = tempCtx.getImageData(0, 0, width, height);
    const float32Buffer = new Float32Array(3 * width * height);
    for (let i = 0; i < imgData.data.length / 4; i++) {
        float32Buffer[i] = imgData.data[i * 4] / 255.0;
        float32Buffer[width * height + i] = imgData.data[i * 4 + 1] / 255.0;
        float32Buffer[2 * width * height + i] = imgData.data[i * 4 + 2] / 255.0;
    }
    return new ort.Tensor('float32', float32Buffer, [1, 3, width, height]);
}

// 核心微調：解決小馬漏報、解決統計卡在 x5 限制
function postprocess(data, dims) {
    const allDetections = [];
    const confidenceThreshold = 0.30; // 核心修正 1：門檻調降到 30%，強力抓回遠處小馬
    
    const numAttributes = dims[1]; // 84
    const numBoxes = dims[2];      // 8400

    for (let i = 0; i < numBoxes; i++) {
        let maxScore = 0;
        let classId = -1;

        const activeIds = [17, 2, 3, 5, 7];
        for (let c of activeIds) {
            let score = data[(4 + c) * numBoxes + i];
            if (score > maxScore) {
                maxScore = score;
                classId = c;
            }
        }

        if (maxScore > confidenceThreshold) {
            let cx = data[i];
            let cy = data[numBoxes + i];
            let w = data[2 * numBoxes + i];
            let h = data[3 * numBoxes + i];
            let x = cx - w / 2;
            let y = cy - h / 2;

            allDetections.push({ box: [x, y, w, h], score: maxScore, classId: classId });
        }
    }
    
    // 依分數高低排序
    allDetections.sort((a, b) => b.score - a.score);
    
    // 核心修正 2：真實統計不設上限，但畫面上最多畫 8 個最準的框，避免畫面太雜
    const filteredRender = allDetections.slice(0, 8); 
    
    return { allDetections, filteredRender };
}

function renderDetections(renderList, allDetections, totalTime) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    let horseDetected = false;
    let carDetected = false;
    let mainTargetName = "None / 無";
    let mainConfidence = "0%";
    
    // 核心修正 2 的落地：統計「全視野內」的所有物件數量
    let summaryCounts = { '馬匹': 0, '管制車輛': 0 };
    allDetections.forEach(det => {
        if (det.classId === 17) summaryCounts['馬匹']++;
        if ([2, 3, 5, 7].includes(det.classId)) summaryCounts['管制車輛']++;
    });

    const scaleX = canvas.width / MODEL_WIDTH;
    const scaleY = canvas.height / MODEL_HEIGHT;

    // 繪製 Bounding Box
    renderList.forEach(det => {
        const [x, y, w, h] = det.box;
        const config = TARGET_CLASSES[det.classId];
        
        if (det.classId === 17) horseDetected = true;
        if ([2, 3, 5, 7].includes(det.classId)) carDetected = true;

        if (mainTargetName === "None / 無") {
            mainTargetName = `${config.en} / ${config.zh}`;
            mainConfidence = `${Math.round(det.score * 100)}%`;
        }

        ctx.strokeStyle = config.color;
        ctx.lineWidth = det.classId === 17 ? 4 : 2; // 馬匹是入侵者，給予加粗霓虹紅框！
        ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);

        ctx.fillStyle = config.color;
        ctx.font = 'bold 11px monospace';
        ctx.fillText(`${config.en.toUpperCase()}: ${Math.round(det.score * 100)}%`, (x * scaleX) + 5, (y * scaleY) - 5);
    });

    // 刷新下方白底卡片
    document.getElementById('val-target').innerHTML = mainTargetName;
    document.getElementById('val-conf').innerText = mainConfidence;
    document.getElementById('val-time').innerText = `${totalTime} ms / 幀`;

    // 刷新卡片欄位 4：真實物件統計
    const rows = document.querySelectorAll('.info-row');
    if (rows.length >= 4) {
        const valueDiv = rows[3].querySelector('.info-value');
        if (valueDiv) {
            if (summaryCounts['馬匹'] > 0 || summaryCounts['管制車輛'] > 0) {
                let displayTexts = [];
                if (summaryCounts['馬匹'] > 0) displayTexts.push(`馬匹 x${summaryCounts['馬匹']}`);
                if (summaryCounts['管制車輛'] > 0) displayTexts.push(`車輛 x${summaryCounts['管制車輛']}`);
                valueDiv.innerHTML = `<span style="color:#ef233c; font-weight:bold;">${displayTexts.join(' | ')}</span>`;
            } else { valueDiv.innerText = "Scanning... / 區域安全"; }
        }
    }

    // ==========================================
    // 🚨 核心修正 4 & 5：移除 Kaggle，觸發安防警報
    // ==========================================
    if (horseDetected) {
        // 突發入侵：橫條炸開成危險紅色，觸發強烈視覺警告
        statusBanner.style.background = "linear-gradient(135deg, #ef233c 0%, #d90429 100%)";
        statusBanner.style.boxShadow = "0 0 20px rgba(239,35,60,0.6)";
        statusIcon.innerHTML = '🚨';
        statusText.innerHTML = '<span style="animation: blink 0.8s infinite; font-weight:bold; color:#fff;">⚠️ 警告：偵測到非法馬匹闖入管制區！</span>';
    } else if (carDetected) {
        // 正常的車輛進出管制
        statusBanner.style.background = "linear-gradient(135deg, #0077b6 0%, #03045e 100%)";
        statusBanner.style.boxShadow = "none";
        statusIcon.innerHTML = '✓';
        statusText.innerHTML = '🚗 Adroit+ 安全防線：車輛管制中';
    } else {
        // 巡邏掃描狀態
        statusBanner.style.background = "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)";
        statusBanner.style.boxShadow = "none";
        statusIcon.innerHTML = '🔍';
        statusText.innerHTML = 'Adroit+ AI 系統實時掃描中...';
    }
}

// 快照功能
snapBtn.addEventListener('click', () => {
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = canvas.width; snapCanvas.height = canvas.height;
    const snapCtx = snapCanvas.getContext('2d');
    snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
    snapCtx.drawImage(canvas, 0, 0, snapCanvas.width, snapCanvas.height);
    const imgUrl = snapCanvas.toDataURL('image/png');
    const overlay = document.createElement('div');
    overlay.style = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.9); z-index:9999; display:flex; flex-direction:column; align-items:center; justify-content:center;";
    overlay.innerHTML = `
        <p style="color:#ff4d6d; font-weight:bold; margin-bottom:15px;">🚨 Adroit+ 安防入侵快照</p>
        <img src="${imgUrl}" style="width:85%; max-width:380px; border-radius:12px; border:3px solid #ef233c; box-shadow: 0 0 25px rgba(239,35,60,0.4);"/>
        <p style="color:#8d99ae; font-size:0.85rem; margin-top:15px;">💡 長按圖片即可儲存至 iPhone</p>
        <button id="closeSnap" style="margin-top:20px; background:#ef233c; color:#fff; border:none; padding:10px 25px; border-radius:20px; font-weight:bold;">關閉</button>
    `;
    document.body.appendChild(overlay);
    document.getElementById('closeSnap').onclick = () => overlay.remove();
});

// 在全域動態注入文字閃爍的 CSS 動畫效果
const style = document.createElement('style');
style.innerHTML = `@keyframes blink { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }`;
document.head.appendChild(style);

window.onload = init;
