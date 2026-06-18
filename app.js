const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const statusBanner = document.getElementById('statusBanner');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const snapBtn = document.getElementById('snapBtn');

let session = null;
let lastAlertTime = 0;
const MODEL_WIDTH = 640;  // YOLOv9 標準輸入規格 (寬)
const MODEL_HEIGHT = 640; // YOLOv9 標準輸入規格 (高)

// ==========================================
// 1. 初始化系統：載入 AI 模型並開啟 iPhone 後鏡頭
// ==========================================
async function init() {
    try {
        console.log("正在載入 YOLOv9 ONNX 模型...");
        // 優先啟動 WebGL 硬體加速，若瀏覽器不支援則自動降級至 WebAssembly (WASM) 執行
        session = await ort.InferenceSession.create('./best.onnx', { executionProviders: ['webgl', 'wasm'] });
        console.log("Adroit+ AI 模型載入成功！");

        setupCamera();
    } catch (e) {
        console.error("AI 模型初始化失敗:", e);
        alert("無法加載 best.onnx 檔案。請確保該模型檔案已放置在專案根目錄中。");
    }
}

// ==========================================
// 2. 啟動相機權限與視訊流 (強制後置鏡頭)
// ==========================================
function setupCamera() {
    // facingMode: "environment" 能精準調用 iPhone 的後置主鏡頭
    navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: 640, height: 480 },
        audio: false
    })
    .then((stream) => {
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', () => {
            // 將畫布大小同步為相機的真實解析度
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            // 啟動即時辨識無窮迴圈
            requestAnimationFrame(processFrame);
        });
    })
    .catch((err) => {
        console.error("相機存取被拒絕: ", err);
        alert("請允許網頁存取相機，以啟動即時辨識功能。");
    });
}

// ==========================================
// 3. 核心偵測迴圈 (Per-Frame Processing)
// ==========================================
async function processFrame() {
    if (video.paused || video.ended) return;

    // 前處理：擷取當前相機影格並轉換成 YOLO 要求的 1x3x640x640 浮點數張量 (Tensor)
    const tensorInput = preprocess(video, MODEL_WIDTH, MODEL_HEIGHT);

    // 封裝輸入數據並交由 ONNX Runtime Web 推理
    const feeds = {};
    feeds[session.inputNames[0]] = tensorInput;
    const outputMap = await session.run(feeds);
    
    // 取得模型的第一層輸出
    const outputTensor = outputMap[session.outputNames[0]];
    
    // 後處理：解析邊界框坐標與過濾馬匹類別的分數
    const detections = postprocess(outputTensor.data, outputTensor.dims);
    
    // 將結果即時渲染到 UI 與數據卡片上
    renderDetections(detections);

    // 迴圈觸發下一影格
    requestAnimationFrame(processFrame);
}

// ==========================================
// 4. 影像前處理 (Preprocessing)
// ==========================================
function preprocess(videoElement, width, height) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(videoElement, 0, 0, width, height);
    
    const imgData = tempCtx.getImageData(0, 0, width, height);
    const float32Buffer = new Float32Array(3 * width * height);

    // NCHW 排列優化：依序排入 R, G, B 通道，並將 0-255 的像素歸一化至 0.0 - 1.0 區間
    for (let i = 0; i < imgData.data.length / 4; i++) {
        float32Buffer[i] = imgData.data[i * 4] / 255.0;                        // R 通道
        float32Buffer[width * height + i] = imgData.data[i * 4 + 1] / 255.0;   // G 通道
        float32Buffer[2 * width * height + i] = imgData.data[i * 4 + 2] / 255.0; // B 通道
    }

    return new ort.Tensor('float32', float32Buffer, [1, 3, width, height]);
}

// ==========================================
// 5. 模型數據解析 (Postprocessing)
// ==========================================
function postprocess(data, dims) {
    const detections = [];
    const confidenceThreshold = 0.50; // 信心度門檻過濾設定為 50%
    
    const numBoxes = dims[2]; 
    // 標準客製化單類別（馬）輸出矩陣解析
    for (let i = 0; i < numBoxes; i++) {
        let score = data[4 * numBoxes + i]; // 第五行通常為目標置信度分數
        
        if (score > confidenceThreshold) {
            let cx = data[i];
            let cy = data[numBoxes + i];
            let w = data[2 * numBoxes + i];
            let h = data[3 * numBoxes + i];

            // 坐標中心點轉換至 UIKit/HTML 左上角坐標點
            let x = cx - w / 2;
            let y = cy - h / 2;

            detections.push({
                box: [x, y, w, h],
                score: score
            });
        }
    }
    return detections;
}

// ==========================================
// 6. UI 狀態動態更新與霓虹智慧框渲染 (Render)
// ==========================================
function renderDetections(detections) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let horseFound = false;
    let highestScore = 0;

    detections.forEach(det => {
        horseFound = true;
        if (det.score > highestScore) highestScore = det.score;

        const [x, y, w, h] = det.box;
        const scaleX = canvas.width / MODEL_WIDTH;
        const scaleY = canvas.height / MODEL_HEIGHT;

        // 繪製與 Adroit 完美搭配的霓虹綠智慧對焦框
        ctx.strokeStyle = '#00ffcc';
        ctx.lineWidth = 3;
        ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);

        // 在框線上方加上辨識率文字
        ctx.fillStyle = '#00ffcc';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(`Horse: ${Math.round(det.score * 100)}%`, x * scaleX, (y * scaleY) - 8);
    });

    // 連動還原 584.png 的 UI 設計樣式
    if (horseFound) {
        // 切換為「綠色驗證成功」型態
        statusBanner.classList.add('detected');
        statusIcon.innerHTML = '✓';
        statusText.innerHTML = 'Validated 已驗證';

        // 即時刷新下方的數據資訊卡片
        document.getElementById('val-target').innerText = 'Horse / 馬匹';
        document.getElementById('val-conf').innerText = `${Math.round(highestScore * 100)}%`;
        
        // 生成當前系統的真實檢測時間戳記
        const now = new Date();
        const timeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} - ${now.getDate()}, June 6月, ${now.getFullYear()}`;
        document.getElementById('val-time').innerText = timeString;

        // 觸發物理擴充警報
        triggerAlertEffects();
    } else {
        // 還原為「藍灰色掃描中」型態
        statusBanner.classList.remove('detected');
        statusIcon.innerHTML = '?';
        statusText.innerHTML = 'Scanning 掃描中...';
    }
}

// ==========================================
// 7. 手機硬體回饋：震動與電子音效 (安全節流機制)
// ==========================================
function triggerAlertEffects() {
    const now = Date.now();
    // 限制每 2 秒最多觸發一次系統回饋，避免 iPhone 震動馬達過載或卡死
    if (now - lastAlertTime > 2000) {
        lastAlertTime = now;
        
        // 觸發流動裝置物理震動
        if (navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
        }
        
        // 使用 Web Audio API 生成專業的嗶嗶電子短音
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz
        oscillator.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.12); // 發聲 0.12 秒
    }
}

// ==========================================
// 8. 複合快照功能 (結合鏡頭串流與綠色 AI 框)
// ==========================================
snapBtn.addEventListener('click', () => {
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = canvas.width;
    snapCanvas.height = canvas.height;
    const snapCtx = snapCanvas.getContext('2d');

    // 雙層圖層疊加：底層相機影格 + 頂層 AI 綠色線框
    snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
    snapCtx.drawImage(canvas, 0, 0, snapCanvas.width, snapCanvas.height);

    // 觸發本機下載行為將圖片保存至手機
    const link = document.createElement('a');
    link.download = `adroit-snapshot-${Date.now()}.png`;
    link.href = snapCanvas.toDataURL('image/png');
    link.click();
});

// 啟動專案
window.onload = init;
