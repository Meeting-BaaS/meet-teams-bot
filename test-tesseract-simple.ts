import Tesseract from 'tesseract.js'

async function testTesseractJS() {
    console.log('🧪 Testing Tesseract.js v6 Integration...')

    try {
        console.log('📦 Creating worker...')
        const worker = await Tesseract.createWorker('eng')

        console.log('🔧 Setting parameters...')
        await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
        })

        console.log('✅ Tesseract.js v6 integration successful!')
        console.log('📋 Worker created and configured correctly')

        await worker.terminate()
        console.log('🛑 Worker terminated')
    } catch (error) {
        console.error('❌ Tesseract.js test failed:', error)
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    testTesseractJS().catch(console.error)
}

export { testTesseractJS }
