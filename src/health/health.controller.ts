import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MatrixService } from '../matrix/matrix.service';
import { JanusService } from '../janus/janus.service';

/**
 * Health check endpoint reporting live connectivity to Matrix Synapse and
 * Janus Gateway. Does not require authentication — suitable for load balancer
 * probes and uptime monitors.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly matrix: MatrixService,
    private readonly janus: JanusService,
  ) {}

  /**
   * Returns service connectivity status for Matrix and Janus.
   */
  @Get()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns the connectivity state of Matrix Synapse and Janus Gateway. ' +
      'The overall `status` is always "ok" — inspect the `matrix` and `janus` ' +
      'fields to determine which transports are currently reachable.',
  })
  @ApiResponse({
    status: 200,
    description: 'Health status. Example: `{ status: "ok", matrix: "connected", janus: "disconnected" }`.',
  })
  check() {
    return {
      status: 'ok',
      matrix: this.matrix.isAvailable() ? 'connected' : 'disconnected',
      janus: this.janus.isAvailable() ? 'connected' : 'disconnected',
    };
  }
}
