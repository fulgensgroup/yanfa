# yanfa
Yet another FFMPEG API

A powerful, asynchronous REST API for FFmpeg that accepts arbitrary commands and parameters. Perfect for complex video processing tasks like compositing, color keying, and advanced filtering.

## Features

- **Asynchronous processing** with job queue
- **Arbitrary FFmpeg commands** - full flexibility
- **Progress tracking** with real-time updates  
- **Multiple file uploads** for complex operations
- **Automatic cleanup** and resource management
- **Docker ready** for easy deployment

## Endpoints
POST /process - Start processing job
GET /jobs/:jobId - Get job status
GET /jobs/:jobId/download - Download completed output
GET /jobs - List all jobs
DELETE /jobs/:jobId - Delete/cancel job
### Using Docker Compose

```bash
git clone <your-repo-url>
cd flexible-ffmpeg-api
docker-compose up -d