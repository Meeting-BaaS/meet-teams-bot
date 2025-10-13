import { calculateVideoOffset } from './src/utils/CalculVideoOffset';

async function testNewFiles() {
    const audioPath = '/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output_1.flac';
    const videoPath = '/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output_1.mp4';
    
    console.log('🧪 Testing NEW files...');
    console.log(`Audio: ${audioPath}`);
    console.log(`Video: ${videoPath}`);
    
    try {
        const result = await calculateVideoOffset(audioPath, videoPath);
        console.log('\n📊 RESULT:');
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testNewFiles(); 
