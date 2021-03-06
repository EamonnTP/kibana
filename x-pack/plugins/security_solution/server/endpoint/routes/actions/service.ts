/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ElasticsearchClient, Logger } from 'kibana/server';
import { AGENT_ACTIONS_INDEX, AGENT_ACTIONS_RESULTS_INDEX } from '../../../../../fleet/common';
import { SecuritySolutionRequestHandlerContext } from '../../../types';
import { ActivityLog, EndpointAction } from '../../../../common/endpoint/types';

export const getAuditLogResponse = async ({
  elasticAgentId,
  page,
  pageSize,
  context,
  logger,
}: {
  elasticAgentId: string;
  page: number;
  pageSize: number;
  context: SecuritySolutionRequestHandlerContext;
  logger: Logger;
}): Promise<{
  page: number;
  pageSize: number;
  data: ActivityLog['data'];
}> => {
  const size = Math.floor(pageSize / 2);
  const from = page <= 1 ? 0 : page * size - size + 1;
  const esClient = context.core.elasticsearch.client.asCurrentUser;

  const data = await getActivityLog({ esClient, from, size, elasticAgentId, logger });

  return {
    page,
    pageSize,
    data,
  };
};

const getActivityLog = async ({
  esClient,
  size,
  from,
  elasticAgentId,
  logger,
}: {
  esClient: ElasticsearchClient;
  elasticAgentId: string;
  size: number;
  from: number;
  logger: Logger;
}) => {
  const options = {
    headers: {
      'X-elastic-product-origin': 'fleet',
    },
    ignore: [404],
  };

  let actionsResult;
  let responsesResult;

  try {
    actionsResult = await esClient.search(
      {
        index: AGENT_ACTIONS_INDEX,
        size,
        from,
        body: {
          query: {
            bool: {
              filter: [
                { term: { agents: elasticAgentId } },
                { term: { input_type: 'endpoint' } },
                { term: { type: 'INPUT_ACTION' } },
              ],
            },
          },
          sort: [
            {
              '@timestamp': {
                order: 'desc',
              },
            },
          ],
        },
      },
      options
    );
    const actionIds = actionsResult?.body?.hits?.hits?.map(
      (e) => (e._source as EndpointAction).action_id
    );

    responsesResult = await esClient.search(
      {
        index: AGENT_ACTIONS_RESULTS_INDEX,
        size: 1000,
        body: {
          query: {
            bool: {
              filter: [{ term: { agent_id: elasticAgentId } }, { terms: { action_id: actionIds } }],
            },
          },
        },
      },
      options
    );
  } catch (error) {
    logger.error(error);
    throw error;
  }
  if (actionsResult?.statusCode !== 200) {
    logger.error(`Error fetching actions log for agent_id ${elasticAgentId}`);
    throw new Error(`Error fetching actions log for agent_id ${elasticAgentId}`);
  }

  const responses = responsesResult?.body?.hits?.hits?.length
    ? responsesResult?.body?.hits?.hits?.map((e) => ({
        type: 'response',
        item: { id: e._id, data: e._source },
      }))
    : [];
  const actions = actionsResult?.body?.hits?.hits?.length
    ? actionsResult?.body?.hits?.hits?.map((e) => ({
        type: 'action',
        item: { id: e._id, data: e._source },
      }))
    : [];
  const sortedData = ([...responses, ...actions] as ActivityLog['data']).sort((a, b) =>
    new Date(b.item.data['@timestamp']) > new Date(a.item.data['@timestamp']) ? 1 : -1
  );

  return sortedData;
};
