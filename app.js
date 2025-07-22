const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

// Job storage (in production, use Redis or database)
const jobs = new Map();

// Job statuses
const JobStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/uploads/',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024 // 500MB default
  }
});

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  // Check if required directories exist and FFmpeg is available
  const requiredDirs = ['/tmp/uploads', '/tmp/output'];
  const dirsExist = requiredDirs.every(dir => fs.existsSync(dir));
  
  // Simple FFmpeg availability check
  const ffmpegAvailable = new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    ffmpeg.on('close', (code) => resolve(code === 0));
    ffmpeg.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 1000); // 1 second timeout
  });
  
  ffmpegAvailable.then(available => {
    if (dirsExist && available) {
      res.json({ 
        status: 'ready', 
        timestamp: new Date().toISOString(),
        ffmpeg: 'available',
        storage: 'ready'
      });
    } else {
      res.status(503).json({ 
        status: 'not ready', 
        timestamp: new Date().toISOString(),
        ffmpeg: available ? 'available' : 'unavailable',
        storage: dirsExist ? 'ready' : 'not ready'
      });
    }
  });
});

// Get available endpoints
app.get('/endpoints', (req, res) => {
  res.json({
    endpoints: [
      { method: 'GET', path: '/health', description: 'Health check - returns "ready" when service is ready for requests' },
      { method: 'GET', path: '/endpoints', description: 'List available endpoints' },
      { method: 'POST', path: '/process', description: 'Start processing job with arbitrary FFmpeg parameters' },
      { method: 'GET', path: '/jobs/:jobId', description: 'Get job status and info' },
      { method: 'GET', path: '/jobs/:jobId/download', description: 'Download completed job output' },
      { method: 'DELETE', path: '/jobs/:jobId', description: 'Cancel/delete job' },
      { method: 'GET', path: '/jobs', description: 'List all jobs' }
    ]
  });
});

// Start processing job
app.post('/process', upload.array('files', 10), async (req, res) => {
  const jobId = uuidv4();
  const outputDir = `/tmp/output/${jobId}`;
  
  try {
    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });
    
    const { ffmpegArgs, outputFilename = 'output.mp4' } = req.body;
    
    if (!ffmpegArgs) {
      return res.status(400).json({ error: 'ffmpegArgs parameter is required' });
    }
    
    // Parse ffmpeg arguments
    let args;
    try {
      args = typeof ffmpegArgs === 'string' ? JSON.parse(ffmpegArgs) : ffmpegArgs;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid ffmpegArgs JSON format' });
    }
    
    // Map uploaded files to their paths
    const fileMapping = {};
    const inputFiles = [];
    if (req.files) {
      req.files.forEach((file, index) => {
        const key = file.fieldname || `input${index}`;
        fileMapping[key] = file.path;
        inputFiles.push(file.path);
      });
    }
    
    // Create job record
    const job = {
      id: jobId,
      status: JobStatus.QUEUED,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      progress: 0,
      ffmpegArgs: args,
      outputFilename,
      outputPath: path.join(outputDir, outputFilename),
      inputFiles,
      error: null,
      logs: []
    };
    
    jobs.set(jobId, job);
    
    // Return job ID immediately
    res.status(202).json({
      jobId,
      status: JobStatus.QUEUED,
      message: 'Job queued for processing',
      statusUrl: `/jobs/${jobId}`,
      downloadUrl: `/jobs/${jobId}/download`
    });
    
    // Start processing asynchronously
    setImmediate(() => processJob(jobId, args, fileMapping, job));
    
  } catch (error) {
    console.error(`[${jobId}] Error creating job:`, error);
    res.status(500).json({ error: error.message });
    
    // Cleanup
    if (req.files) {
      req.files.forEach(file => {
        fs.unlink(file.path, () => {});
      });
    }
    fs.rmdir(outputDir, { recursive: true }, () => {});
  }
});

// Get job status
app.get('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    progress: job.progress,
    outputFilename: job.outputFilename,
    error: job.error,
    downloadUrl: job.status === JobStatus.COMPLETED ? `/jobs/${job.id}/download` : null
  });
});

// Download completed job
app.get('/jobs/:jobId/download', (req, res) => {
  const job = jobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (job.status !== JobStatus.COMPLETED) {
    return res.status(400).json({ 
      error: 'Job not completed', 
      status: job.status 
    });
  }
  
  if (!fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Output file not found' });
  }
  
  res.download(job.outputPath, job.outputFilename, (err) => {
    if (err) {
      console.error(`[${job.id}] Error sending file:`, err);
    }
  });
});

// Delete/cancel job
app.delete('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const wasCompleted = job.status === JobStatus.COMPLETED;
  
  // Cleanup input files
  if (job.inputFiles) {
    job.inputFiles.forEach(file => {
      fs.unlink(file, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.warn(`Failed to delete input file ${file}:`, err.message);
        }
      });
    });
  }
  
  // Cleanup output files and directory
  if (job.outputPath) {
    const outputDir = path.dirname(job.outputPath);
    
    // Delete output file
    fs.unlink(job.outputPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.warn(`Failed to delete output file ${job.outputPath}:`, err.message);
      }
    });
    
    // Delete output directory
    fs.rmdir(outputDir, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.warn(`Failed to delete output directory ${outputDir}:`, err.message);
      }
    });
  }
  
  jobs.delete(req.params.jobId);
  
  res.json({ 
    message: 'Job deleted successfully',
    jobId: req.params.jobId,
    wasCompleted,
    filesDeleted: {
      inputFiles: job.inputFiles?.length || 0,
      outputFile: job.outputPath ? 1 : 0
    }
  });
});

// List all jobs
app.get('/jobs', (req, res) => {
  const jobList = Array.from(jobs.values()).map(job => ({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    progress: job.progress,
    outputFilename: job.outputFilename
  }));
  
  res.json({ jobs: jobList });
});

// Process job function
async function processJob(jobId, args, fileMapping, job) {
  try {
    console.log(`[${jobId}] Starting job processing`);
    
    job.status = JobStatus.PROCESSING;
    job.startedAt = new Date().toISOString();
    job.progress = 10;
    
    // Replace file placeholders in arguments with actual paths
    const processedArgs = args.map(arg => {
      if (typeof arg === 'string' && arg.startsWith('{{') && arg.endsWith('}}')) {
        const placeholder = arg.slice(2, -2);
        return fileMapping[placeholder] || arg;
      }
      return arg;
    });
    
    // Add output file path
    processedArgs.push(job.outputPath);
    
    console.log(`[${jobId}] Running FFmpeg with args:`, processedArgs);
    
    // Execute FFmpeg
    const ffmpeg = spawn('ffmpeg', ['-y', '-progress', 'pipe:1', ...processedArgs]);
    
    let stderr = '';
    let duration = null;
    let currentTime = null;
    
    // Parse progress from stdout
    ffmpeg.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.startsWith('duration=')) {
          duration = parseTime(line.split('=')[1]);
        } else if (line.startsWith('out_time=')) {
          currentTime = parseTime(line.split('=')[1]);
          if (duration && currentTime) {
            job.progress = Math.min(90, Math.round((currentTime / duration) * 80) + 10);
          }
        }
      });
    });
    
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      job.logs.push(data.toString().trim());
    });
    
    ffmpeg.on('close', (code) => {
      // Cleanup input files
      if (job.inputFiles) {
        job.inputFiles.forEach(file => {
          fs.unlink(file, () => {});
        });
      }
      
      if (code === 0) {
        console.log(`[${jobId}] Job completed successfully`);
        job.status = JobStatus.COMPLETED;
        job.completedAt = new Date().toISOString();
        job.progress = 100;
      } else {
        console.error(`[${jobId}] FFmpeg failed with code ${code}`);
        job.status = JobStatus.FAILED;
        job.completedAt = new Date().toISOString();
        job.error = `FFmpeg processing failed with exit code ${code}`;
        job.logs.push(`Process exited with code ${code}`);
        
        // Cleanup output directory on failure
        const outputDir = path.dirname(job.outputPath);
        fs.rmdir(outputDir, { recursive: true }, () => {});
      }
    });
    
    // Handle timeout
    const timeout = setTimeout(() => {
      ffmpeg.kill();
      job.status = JobStatus.FAILED;
      job.completedAt = new Date().toISOString();
      job.error = 'Processing timeout';
    }, parseInt(process.env.TIMEOUT_MS) || 300000); // 5 minutes default
    
    ffmpeg.on('close', () => {
      clearTimeout(timeout);
    });
    
  } catch (error) {
    console.error(`[${jobId}] Processing error:`, error);
    job.status = JobStatus.FAILED;
    job.completedAt = new Date().toISOString();
    job.error = error.message;
    
    // Cleanup
    if (job.inputFiles) {
      job.inputFiles.forEach(file => {
        fs.unlink(file, () => {});
      });
    }
    const outputDir = path.dirname(job.outputPath);
    fs.rmdir(outputDir, { recursive: true }, () => {});
  }
}

// Helper function to parse time from FFmpeg progress
function parseTime(timeStr) {
  if (!timeStr || timeStr === 'N/A') return null;
  
  const parts = timeStr.split(':');
  if (parts.length !== 3) return null;
  
  const hours = parseFloat(parts[0]);
  const minutes = parseFloat(parts[1]);
  const seconds = parseFloat(parts[2]);
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Cleanup old jobs periodically (every hour)
setInterval(() => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
  
  for (const [jobId, job] of jobs) {
    if (new Date(job.createdAt) < cutoff) {
      console.log(`Cleaning up old job: ${jobId}`);
      
      // Cleanup files
      if (job.inputFiles) {
        job.inputFiles.forEach(file => {
          fs.unlink(file, () => {});
        });
      }
      
      if (job.outputPath) {
        const outputDir = path.dirname(job.outputPath);
        fs.unlink(job.outputPath, () => {});
        fs.rmdir(outputDir, () => {});
      }
      
      jobs.delete(jobId);
    }
  }
}, 60 * 60 * 1000); // Run every hour

app.listen(port, () => {
  console.log(`Async FFmpeg API server running on port ${port}`);
  
  // Create necessary directories
  fs.mkdirSync('/tmp/uploads', { recursive: true });
  fs.mkdirSync('/tmp/output', { recursive: true });
});

module.exports = app;