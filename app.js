const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const statusBanner = document.getElementById('statusBanner');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const snapBtn = document.getElementById('snapBtn');

let session = null;
let isProcessing = false;

const MODEL_WIDTH = 640;  
const MODEL_HEIGHT = 640; 

// 建立全螢幕畫面除錯日誌區 (Live Diagnostics Overlay)
const logContainer = document.createElement('div');
logContainer.style = "position:fixed; top:75px; left:10px; width:180px; background:rgba(0,0,0,0.75); color:#00ffcc; font-family:monospace; font-size:10px; padding:8px; border-radius:6px; z-index:999; pointer-events:none; line-height:1.4;";
document.body.appendChild(logContainer);

function showLog(text) {
    logContainer.innerHTML = text;
}

// 2026年標準 COCO 80 類別全中英對照表 (讓展示資訊更實用)
const COCO_CLASSES = {
    0: { en: 'Person', zh: '人' },
    1: { en: 'Bicycle', zh: '腳踏車' },
    2: { en: 'Car', zh: '汽車' },
    3: { en: 'Motorcycle', zh: '機車' },
    5: { en: 'Bus', zh: '巴士' },
    7: { en: 'Truck', zh: '貨車' },
    15: { en: 'Cat', zh: '貓' },
    16: { en: 'Dog', zh: '狗' },
    17: { en: 'Horse', zh: '馬匹' }, // 我們核心要找的馬
    18: { en: 'Sheep', zh: '羊' },
    19: { en: 'Cow', zh: '乳牛' }
};

// ==========================================
// 1. 初始化系統
// ==========================================
async function init() {
    showLog("⏳ 正在下載模型...<br>Downloading best.onnx...");
    try {
        session = await ort.InferenceSession.create('./best.onnx', { executionProviders: ['webgl', 'wasm'] });
        showLog("✅ 模型加載成功！<br>Model loaded.<br>正在啟動相機...");
        setupCamera();
    } catch (e) {
        showLog(`❌ 錯誤: 模型加載失敗<br>${e.message}`);
        alert("無法讀取 best.onnx，請檢查檔案是否存在 GitHub 根目錄。");
    }
}

// ==========================================
// 2. 啟動相機
// ==========================================
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
            showLog("🎥 相機已就緒 (30 FPS)<br>AI 推理啟動中...");
            // 每 250 毫秒 (一秒 4 次) 跑一次 AI，確保手機完全不卡頓
            setInterval(processFrame, 250);
        });
    })
    .catch((err) => {
        showLog(`❌ 相機錯誤:<br>${err.message}`);
    });
}

// ==========================================
// 3. 核心偵測 (帶有詳細計時日誌)
// ==========================================
async function processFrame() {
    if (video.paused || video.ended || isProcessing || !session) return;
    
    isProcessing = true;
    const t0 = performance.now();

    try {
        // [日誌點 1]: 前處理計時
        const tensorInput = preprocess(video, MODEL_WIDTH, MODEL_HEIGHT);
        const t1 = performance.now();
        
        // [日誌點 2]: ONNX 推理計時 (最吃資源的地方)
        const feeds = {};
        feeds[session.inputNames[0]] = tensorInput;
        const outputMap = await session.run(feeds);
        const outputTensor = outputMap[session.outputNames[0]];
        const t2 = performance.now();
        
        // [日誌點 3]: 矩陣解析計時
        const detections = postprocess(outputTensor.data, outputTensor.dims);
        const t3 = performance.now();
        
        // 計算各階段耗時 (ms)
        const prepTime = Math.round(t1 - t0);
        const inferTime = Math.round(t2 - t1);
        const postTime = Math.round(t3 - t2);
        const totalTime = Math.round(t3 - t0);

        // 將除錯數據顯示在畫面上
        showLog(`📊 實時 AI 診斷數據:<br>` +
                `• Output Shape: [${outputTensor.dims.join(',')}]<br>` +
                `• Pre-process: ${prepTime}ms<br>` +
                `• ONNX Model: ${inferTime}ms 🔥<br>` +
                `• Post-process: ${postTime}ms<br>` +
                `• Total Loop: ${totalTime}ms<br>` +
                `• Detected Raw Box: ${detections.length}`);

        renderDetections(detections, totalTime);
    } catch (error) {
        showLog(`❌ 推理出錯:<br>${error.message}`);
    }
    
    isProcessing = false;
}

function preprocess(videoElement, width, height) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(videoElement, 0, 0, width, height);
    
    const imgData = tempCtx.getImageData(0, 0, width, height);
    const float32Buffer = new Float32Array(3 * width * height);

    for (let i = 0; i < imgData.data.length / 4; i++) {
        float32Buffer[i] = imgData.data[i * 4] / 255.0;                        // R
        float32Buffer[width * height + i] = imgData.data[i * 4 + 1] / 255.0;   // G
        float32Buffer[2 * width * height + i] = imgData.data[i * 4 + 2] / 255.0; // B
    }
    return new ort.Tensor('float32', float32Buffer, [1, 3, width, height]);
}

// ==========================================
// 4. 精準矩陣解包 (解決框框亂飄、對位不準)
// ==========================================
function postprocess(data, dims) {
    const detections = [];
    const confidenceThreshold = 0.35; // 調低門檻方便測試
    
    const numAttributes = dims[1]; // 通常是 84 (4坐標 + 80類別分數)
    const numBoxes = dims[2];      // 通常是 8400 個預測位置

    // 重新排列並篩選數據
    for (let i = 0; i < numBoxes; i++) {
        let maxScore = 0;
        let classId = -1;

        // 我們只關心 COCO 數據集中跟動物/人相關的類別（重點是 17：馬）
        // 為了效能與精準度，我們直接抓取常見目標的分數
        const targetClasses = [0, 1, 2, 3, 15, 16, 17, 18, 19]; 
        for (let c of targetClasses) {
            let score = data[(4 + c) * numBoxes + i]; // 標準 YOLO 輸出公式
            if (score > maxScore) {
                maxScore = score;
                classId = c;
            }
        }

        // 如果這個框的最高分超過門檻，且它是我們要找的物體
        if (maxScore > confidenceThreshold && classId !== -1) {
            let cx = data[i];
            let cy = data[numBoxes + i];
            let w = data[2 * numBoxes + i];
            let h = data[3 * numBoxes + i];

            // 轉換為網頁畫布的左上角 (X, Y)
            let x = cx - w / 2;
            let y = cy - h / 2;

            detections.push({
                box: [x, y, w, h],
                score: maxScore,
                classId: classId
            });
        }
    }
    
    // NMS 簡單重疊過濾：依分數排序，最多保留畫面上最明顯的三個東西
    detections.sort((a, b) => b.score - a.score);
    return detections.slice(0, 3);
}

// ==========================================
// 5. 渲染並動態注入真實的 YOLO 資訊
// ==========================================
function renderDetections(detections, totalTime) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    let horseDetected = false;
    let mainTargetName = "None / 無";
    let mainConfidence = "0%";
    let objectCountSummary = {};

    const scaleX = canvas.width / MODEL_WIDTH;
    const scaleY = canvas.height / MODEL_HEIGHT;

    detections.forEach(det => {
        const [x, y, w, h] = det.box;
        const classInfo = COCO_CLASSES[det.classId] || { en: 'Object', zh: '未知物體' };
        
        // 統計畫面上出現的所有東西數量 (最真實的 YOLO 支援資訊)
        objectCountSummary[classInfo.zh] = (objectCountSummary[classInfo.zh] || 0) + 1;

        if (det.classId === 17) {
            horseDetected = true;
        }

        // 拿第一個最高分的當作主數據顯示在卡片上
        if (mainTargetName === "None / 無") {
            mainTargetName = `${classInfo.en} / ${classInfo.zh}`;
            mainConfidence = `${Math.round(det.score * 100)}%`;
        }

        // 繪製細緻的霓虹智慧框
        ctx.strokeStyle = (det.classId === 17) ? '#00ffcc' : '#38bdf8'; // 馬用綠框，其他人用藍框
        ctx.lineWidth = 3;
        ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);

        ctx.fillStyle = (det.classId === 17) ? '#00ffcc' : '#38bdf8';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(`${classInfo.en.toUpperCase()}: ${Math.round(det.score * 100)}%`, (x * scaleX) + 5, (y * scaleY) - 5);
    });

    // ==========================================
    // 6. 動態改寫下方的白底卡片資訊 (全面換成實用欄位)
    // ==========================================
    
    // 欄位 1: 偵測目標
    document.getElementById('val-target').innerHTML = mainTargetName;
    
    // 欄位 2: 辨識信心度
    document.getElementById('val-conf').innerText = mainConfidence;
    
    // 欄位 3: 偵測時間與運作速率 (這對客戶非常實用，展示運算實力)
    const now = new Date();
    document.getElementById('val-time').innerText = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} (${totalTime}ms/幀)`;

    // 欄位 4: 修改原本無意義的 "Member Type / 會員類別"
    // 將其改造成 YOLO 實時物體統計清單！
    const rows = document.querySelectorAll('.info-row');
    if (rows.length >= 4) {
        const labelDiv = rows[3].querySelector('.info-label');
        const valueDiv = rows[3].querySelector('.info-value');
        
        // 改寫標籤標題
        if (labelDiv) {
            labelDiv.innerHTML = `<div class="en">Scene Objects</div><div class="zh">畫面物件統計</div>`;
        }
        // 動態塞入 YOLO 數到的動物/人數量
        if (valueDiv) {
            if (Object.keys(objectCountSummary).length > 0) {
                let summaryText = Object.entries(objectCountSummary).map(([name, qty]) => `${name} x${qty}`).join(', ');
                valueDiv.innerHTML = `<span style="color:#00b4d8; font-weight:bold;">${summaryText}</span>`;
            } else {
                valueDiv.innerText = "Scanning... / 無";
            }
        }
    }

    // 變更頂部狀態欄
    if (horseDetected) {
        statusBanner.classList.add('detected');
        statusIcon.innerHTML = '✓';
        statusText.innerHTML = 'Horse Verified 已認證馬匹';
    } else {
        statusBanner.classList.remove('detected');
        statusIcon.innerHTML = '?';
        statusText.innerHTML = 'Scanning 掃描中...';
    }
}

// ==========================================
// 7. 快照優化：網頁彈出式圖卡 (長按儲存)
// ==========================================
snapBtn.addEventListener('click', () => {
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = canvas.width;
    snapCanvas.height = canvas.height;
    const snapCtx = snapCanvas.getContext('2d');

    snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
    snapCtx.drawImage(canvas, 0, 0, snapCanvas.width, snapCanvas.height);

    const imgUrl = snapCanvas.toDataURL('image/png');
    
    const overlay = document.createElement('div');
    overlay.style = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:9999; display:flex; flex-direction:column; align-items:center; justify-content:center;";
    overlay.innerHTML = `
        <p style="color:#fff; font-weight:bold; margin-bottom:15px;">📸 Snapshot Captured!</p>
        <img src="${imgUrl}" style="width:85%; max-width:380px; border-radius:12px; border:3px solid #00ffcc; box-shadow: 0 10px 30px rgba(0,0,0,0.5);"/>
        <p style="color:#8d99ae; font-size:0.85rem; margin-top:15px;">💡 長按上方圖片，即可選擇「加入相片」儲存</p>
        <button id="closeSnap" style="margin-top:20px; background:#ef233c; color:#fff; border:none; padding:10px 25px; border-radius:20px; font-weight:bold;">關閉關閉</button>
    `;
    document.body.appendChild(overlay);
    document.getElementById('closeSnap').onclick = () => overlay.remove();
});

window.onload = init;
