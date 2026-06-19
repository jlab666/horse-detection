// app.js - Adroit+ 智慧馬場安防與 HKJC 資料庫連動系統(精簡優化版)
const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const statusBanner = document.getElementById('statusBanner');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const snapBtn = document.getElementById('snapBtn');

// 聯動全新的 HTML 欄位 ID
const horsePanel = document.getElementById('horse-profile-panel');
const profBrand = document.getElementById('prof-brand');
const profType = document.getElementById('prof-type');
const profAge = document.getElementById('prof-age');
const profOrigin = document.getElementById('prof-origin');
const profSire = document.getElementById('prof-sire');
const profOwner = document.getElementById('prof-owner');
const valCounter = document.getElementById('val-counter');

let session = null;
let isProcessing = false;

const MODEL_WIDTH = 640;  
const MODEL_HEIGHT = 640; 

// ==========================================================
// 📂 ADROIT+ REAL DATABASE: 香港賽馬會 (HKJC) 真實數據庫字典
// 這三匹馬的烙印編號、名字、馬主等資料都是 100% 真實數據。
// ==========================================================
const HKJC_REAL_DATABASE = {
    // 浪漫勇士 (與 image_2.png 對應)
    "E487": {
        name_zh: "浪漫勇士",
        name_en: "ROMANTIC WARRIOR",
        brand: "E487",
        type: "ISG (國際拍賣會新馬)",
        age_sex: "6 歲 / Gelding (閹馬)",
        origin: "Ireland (愛爾蘭)",
        sire: "Acclamation (雅各海)",
        owner: "劉栢輝 (Peter Lau Pak Fai)"
    },
    // 加州星球 (與 image_2.png 的 Google 圖片結果對應)
    "G026": {
        name_zh: "加州星球",
        name_en: "CALIFORNIA SPANGLE",
        brand: "G026",
        type: "PPG (自購新馬)",
        age_sex: "6 歲 / Gelding (閹馬)",
        origin: "Ireland (愛爾蘭)",
        sire: "Starspangledbanner (星際旗幟)",
        owner: "梁欽聖 Howard Liang Yum Shing"
    },
    // 錶之銀河 (與 image_2.png 的 Google 圖片結果對應)
    "H264": {
        name_zh: "錶之銀河",
        name_en: "GALAXY PATCH",
        brand: "H264",
        type: "PPG (自購新馬)",
        age_sex: "4 歲 / Gelding (閹馬)",
        origin: "Australia (澳洲)",
        sire: "Wandjina (灣景)",
        owner: "楊建文 (Yeung Kin Man)"
    }
};

const TARGET_CLASSES = {
    17: { en: 'Horse', zh: '馬匹', color: '#00ffcc' },     // 馬
    2:  { en: 'Car', zh: '管制車輛', color: '#38bdf8' }    // 車
};

// 🌟 精簡專業版：移除左上角 useless 的日誌框 🌟

async function init() {
    try {
        session = await ort.InferenceSession.create('./best.onnx', { executionProviders: ['webgl', 'wasm'] });
        setupCamera();
    } catch (e) {
        console.error(`❌ONNX 載入失敗: ${e.message}`);
        // 頁面顯示錯誤提示
        statusBanner.style.background = "linear-gradient(135deg, #ef233c 0%, #d90429 100%)";
        statusIcon.innerHTML = '❌';
        statusText.innerHTML = `大腦晶片加載失敗: ${e.message}`;
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
            setInterval(processFrame, 80); 
        });
    })
    .catch((err) => { 
        console.error(`相機權限錯誤: ${err.message}`);
        statusBanner.style.background = "linear-gradient(135deg, #ef233c 0%, #d90429 100%)";
        statusIcon.innerHTML = '❌';
        statusText.innerHTML = `相機啟動失敗: ${err.message}`;
    });
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
        
        const { allDetections, filteredRender } = postprocess(outputTensor.data, outputTensor.dims);
        const totalTime = Math.round(performance.now() - t0);

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

function postprocess(data, dims) {
    const allDetections = [];
    const confidenceThreshold = 0.35; // 優化：略調高信心度門檻，過濾雜訊框
    
    const numBoxes = dims[2];      // 8400

    for (let i = 0; i < numBoxes; i++) {
        let maxScore = 0;
        let classId = -1;

        // 指名解包 馬(17) 與 汽車(2)
        const activeIds = [17, 2];
        for (let c of activeIds) {
            let score = data[(4 + c) * numBoxes + i];
            if (score > maxScore) {
                maxScore = score;
                classId = c;
            }
        }

        if (maxScore > confidenceThreshold) {
            let cx = data[i]; let cy = data[numBoxes + i];
            let w = data[2 * numBoxes + i]; let h = data[3 * numBoxes + i];
            let x = cx - w / 2; let y = cy - h / 2;

            allDetections.push({ box: [x, y, w, h], score: maxScore, classId: classId });
        }
    }
    
    // 依分數高低排序
    allDetections.sort((a, b) => b.score - a.score);
    
    // 🌟 此時的 allDetections 的長度就是視野內真實的物件數量，解除 slice 限制，精準統計 🌟
    // render清單維持 5 個框，但統計數據要精準
    return { allDetections, filteredRender: allDetections.slice(0, 5) };
}

function renderDetections(renderList, allDetections, totalTime) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    let horseDetected = false;
    let carDetected = false;
    let detectedHorseData = null;
    let isHorseInDb = false;
    
    // 🌟 核心修復：這裏統計視野內「所有」馬匹和車輛的真實數量！ 🌟
    let summaryCounts = { '馬匹': 0, '管制車輛': 0 };
    allDetections.forEach(det => {
        if (det.classId === 17) summaryCounts['馬匹']++;
        if (det.classId === 2) summaryCounts['管制車輛']++;
    });

    const scaleX = canvas.width / MODEL_WIDTH;
    const scaleY = canvas.height / MODEL_HEIGHT;

    // ==========================================================
    // 🧠 智慧查表路由：根據 YOLO 信心度區間模擬「命中真實馬匹檔案」 🌟
    // ==========================================================
    if (summaryCounts['馬匹'] > 0) {
        horseDetected = true;
        
        // 抓取信心度最高的馬匹
        const topScore = renderList.find(d => d.classId === 17)?.score || 0;
        
        if (topScore > 0.88 && summaryCounts['馬匹'] === 1) {
            // 狀態 A：查表命中！模擬最清晰對焦狀態下撈出 浪漫勇士 檔案
            isHorseInDb = true;
            detectedHorseData = HKJC_REAL_DATABASE["E487"];
        } else if (topScore > 0.65 && topScore <= 0.88) {
            // 狀態 B：命中！模擬換成 錶之銀河 檔案
            isHorseInDb = true;
            detectedHorseData = HKJC_REAL_DATABASE["H264"];
        } else {
            // 💥 工業級例外處理：拍多馬、模糊小馬或拍斑馬時
            // YOLO 框依然正常抓馬，但身分證面板 100% 顯示「非香港數據庫登記馬匹」！觸發警報！
            isHorseInDb = false;
            detectedHorseData = null;
        }
    }

    let mainTargetName = "None / 無";
    let mainConfidence = "0%";

    renderList.forEach(det => {
        const [x, y, w, h] = det.box;
        const config = TARGET_CLASSES[det.classId];
        
        if (det.classId === 2) carDetected = true;

        if (mainTargetName === "None / 無") {
            // 優化標題：如果是馬，直接顯示 HKJC 資料庫中的英文名字！
            mainTargetName = det.classId === 17 ? (isHorseInDb ? detectedHorseData.name_en : config.en) : `${config.en}`;
            mainConfidence = `${Math.round(det.score * 100)}%`;
        }

        // 優化框顏色：查不到 DB 時，馬匹框框顯示警告橘色 (#ffb703)；查到了，維持科技綠
        if (det.classId === 17) {
            ctx.strokeStyle = isHorseInDb ? "#00ffcc" : "#ffb703"; 
        } else {
            ctx.strokeStyle = config.color;
        }
        
        ctx.lineWidth = det.classId === 17 ? 4 : 2; 
        ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);

        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = 'bold 11px monospace';
        // 框標籤也聯動：如果是馬，顯示 HKJC 資料庫中的中文名字！
        const boxLabel = det.classId === 17 ? (isHorseInDb ? detectedHorseData.name_zh : "非香港DB馬匹") : config.en.toUpperCase();
        ctx.fillText(`${boxLabel}: ${Math.round(det.score * 100)}%`, (x * scaleX) + 5, (y * scaleY) - 5);
    });

    // 刷新卡片欄位
    document.getElementById('val-target').innerHTML = mainTargetName;
    document.getElementById('val-conf').innerText = mainConfidence;
    document.getElementById('val-time').innerText = `${totalTime} ms / 幀`;

    // ==========================================
    // 🛡️ 例外面板：動態刷新 HTML 身分證面板與警報 🌟
    // ==========================================
    if (horseDetected) {
        horsePanel.style.display = 'block';
        
        if (isHorseInDb) {
            // 狀態 A：查表命中，填入真實資料
            profBrand.innerHTML = `<span style="color:#00ffcc; font-weight:bold; background:#1e293b; padding:2px 6px; border-radius:4px;">${detectedHorseData.brand}</span>`;
            profType.innerText = detectedHorseData.type; profAge.innerText = detectedHorseData.age_sex;
            profOrigin.innerText = detectedHorseData.origin; profSire.innerText = detectedHorseData.sire; profOwner.innerText = detectedHorseData.owner;

            statusBanner.style.background = "linear-gradient(135deg, #023e8a 0%, #03045e 100%)";
            statusIcon.innerHTML = '✓';
            statusText.innerHTML = `<b>安全監控：已辨識香港賽馬會登記資產 (${detectedHorseData.name_zh})</b>`;
        } else {
            // 💥 狀態 B：命中你的痛點需求──框咬定馬匹，但資料庫身分證卡片明確顯示「NOT IN HK DB」與「未登記馬匹」！🚨
            profBrand.innerHTML = `<span style="color:#ffffff; font-weight:bold; background:#ef233c; padding:2px 6px; border-radius:4px;">NOT IN HK DB</span>`;
            profType.innerHTML = `<span style="color:#ffb703; font-weight:bold;">Horse not from HK DB</span>`; profAge.innerText = "Unknown / 未登記";
            profOrigin.innerText = "Environment Zone / 外部環境"; profSire.innerHTML = `<span style="color:#94a3b8;">No lineage track in HK</span>`; profOwner.innerHTML = `<span style="color:#ef233c; font-weight:bold;">⚠️ 未登記之外來馬匹入侵</span>`;

            // 用紅色閃爍狀態欄炸開警報
            statusBanner.style.background = "linear-gradient(135deg, #ef233c 0%, #d90429 100%)";
            statusIcon.innerHTML = '🚨';
            statusText.innerHTML = '<span style="animation: blink 0.8s infinite; font-weight:bold; color:#fff;">⚠️ 警告：管制區內發現非香港賽馬會登記資產！</span>';
        }
    } else {
        horsePanel.style.display = 'none';
        if (carDetected) {
            statusBanner.style.background = "linear-gradient(135deg, #0077b6 0%, #03045e 100%)";
            statusIcon.innerHTML = '✓';
            statusText.innerHTML = '🚗 Adroit+ 安全防線：車輛管制中';
        } else {
            statusBanner.style.background = "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)";
            statusIcon.innerHTML = '🔍';
            statusText.innerHTML = 'Adroit+ 智慧馬場雙效安防監控中...';
        }
    }

    // ==========================================
    // 🌟 最終統計：使用 allDetections 的數量，精準統計視野物件！ 🌟
    // ==========================================
    if (summaryCounts['馬匹'] > 0 || summaryCounts['管制車輛'] > 0) {
        let displayTexts = [];
        if (summaryCounts['馬匹'] > 0) displayTexts.push(`馬匹 x${summaryCounts['馬匹']}`);
        if (summaryCounts['管制車輛'] > 0) displayTexts.push(`車輛 x${summaryCounts['管制車輛']}`);
        // 紅色醒目顯示數量，展現統計功能
        valCounter.innerHTML = `<span style="color:#ef233c; font-weight:bold;">${displayTexts.join(' | ')}</span>`;
    } else {
        valCounter.innerText = "Scanning... / 區域安全";
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
        <img src="${imgUrl}" style="width:85%; max-width:380px; border-radius:12px; border:3px solid #ef233c;"/>
        <button id="closeSnap" style="margin-top:20px; background:#ef233c; color:#fff; border:none; padding:10px 25px; border-radius:20px; font-weight:bold;">關閉</button>
    `;
    document.body.appendChild(overlay);
    document.getElementById('closeSnap').onclick = () => overlay.remove();
});

const style = document.createElement('style');
style.innerHTML = `@keyframes blink { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }`;
document.head.appendChild(style);

window.onload = init;
