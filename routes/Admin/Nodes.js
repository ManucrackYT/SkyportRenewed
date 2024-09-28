const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { db } = require('../../handlers/db.js');
const { logAudit } = require('../../handlers/auditlog.js');

async function checkNodeStatus(node) {
  try {
    const RequestData = {
      method: 'get',
      url: 'http://' + node.address + ':' + node.port + '/',
      auth: {
        username: 'Skyport',
        password: node.apiKey
      },
      headers: { 
        'Content-Type': 'application/json'
      }
    };
    const response = await axios(RequestData);
    const { versionFamily, versionRelease, online, remote, docker } = response.data;

    node.status = 'Online';
    node.versionFamily = versionFamily;
    node.versionRelease = versionRelease;
    node.remote = remote;

    await db.set(node.id + '_node', node);
    return node;
  } catch (error) {
    node.status = 'Offline';
    await db.set(node.id + '_node', node);
    return node;
  }
}

router.get('/admin/nodes', async (req, res) => {
  let nodes = await db.get('nodes') || [];
  let instances = await db.get('instances') || [];
  let set = {};
  nodes.forEach(function(node) {
    set[node] = 0;
    instances.forEach(function(instance) {
      if (instance.Node.id == node) {
        set[node]++;
      }
    });
  });
  nodes = await Promise.all(nodes.map(id => db.get(id + '_node').then(checkNodeStatus)));

  res.render('admin/nodes', { 
    req,
    user: req.user,
    name: await db.get('name') || 'Skyport',
    logo: await db.get('logo') || false,
    nodes,
    set
  });
});

router.post('/nodes/create', async (req, res) => {
  const configureKey = uuidv4();
  const node = {
    id: uuidv4(),
    name: req.body.name,
    tags: req.body.tags,
    ram: req.body.ram,
    disk: req.body.disk,
    processor: req.body.processor,
    address: req.body.address,
    port: req.body.port,
    apiKey: null,
    configureKey: configureKey,
    status: 'Unconfigured'
  };

  if (!req.body.name || !req.body.tags || !req.body.ram || !req.body.disk || !req.body.processor || !req.body.address || !req.body.port) {
    return res.status(400).send('Form validation failure.');
  }

  await db.set(node.id + '_node', node);

  const nodes = await db.get('nodes') || [];
  nodes.push(node.id);
  await db.set('nodes', nodes);

  logAudit(req.user.userId, req.user.username, 'node:create', req.ip);
  res.status(201).json({
    ...node,
    configureKey: configureKey
  });
});

router.post('/nodes/delete', async (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) {
    return res.status(400).json({ error: 'Missing nodeId' });
  }

  try {
    const nodes = await db.get('nodes') || [];
    let foundNode = null;

    for (const id of nodes) {
      const node = await db.get(id + '_node');
      if (node && node.id === nodeId) {
        foundNode = node;
        break;
      }
    }

    if (!foundNode) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const node = foundNode;
    let instances = await db.get('instances') || [];
    let set = {};

    nodes.forEach(function(id) {
      set[id] = 0;
      instances.forEach(function(instance) {
        if (instance.Node.id === id) {
          set[id]++;
        }
      });
    });

    if (set[node.id] > 0) {
      if (!req.query.deleteinstances || req.query.deleteinstances === 'false') {
        return res.status(400).json({ error: 'There are instances on the node' });
      }

      if (req.query.deleteinstances === 'true') {
        let delinstances = instances.filter(function(instance) {
          return instance.Node.id === node.id;
        });

        instances = instances.filter(function(instance) {
          return instance.Node.id !== node.id;
        });

        await db.set('instances', instances);

        for (const instance of delinstances) {
          await db.delete(instance.Id + '_instance');
        }

        for (const instance of delinstances) {
          let userInstances = await db.get(instance.User + '_instances') || [];
          userInstances = userInstances.filter(inst => inst.Id !== instance.Id);
          await db.set(instance.User + '_instances', userInstances);
        }

        try {
          await axios.get(`http://Skyport:${node.apiKey}@${node.address}:${node.port}/instances/purge/all`);
        } catch (apiError) {
          console.error('Error calling purge API:', apiError);
        }
      }
    }

    await db.delete(node.id + '_node');
    nodes.splice(nodes.indexOf(node.id), 1);
    await db.set('nodes', nodes);

    logAudit(req.user.userId, req.user.username, 'node:delete', req.ip);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting node:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/admin/node/:id', async (req, res) => {
  const { id } = req.params;
  const node = await db.get(id + '_node');

  if (!node || !id) return res.redirect('../nodes')

  res.render('admin/node', {
    req,
    user: req.user,
    name: await db.get('name') || 'Skyport',
    logo: await db.get('logo') || false,
    node
  });
});

router.post('/admin/node/:id', async (req, res) => {
  const { id } = req.params;
  const cnode = await db.get(id + '_node');

  if (!cnode || !id) return res.status(400).send();
  
  const node = {
    id: id,
    name: req.body.name,
    tags: req.body.tags,
    ram: req.body.ram,
    disk: req.body.disk,
    processor: req.body.processor,
    address: req.body.address,
    port: req.body.port,
    apiKey: req.body.apiKey,
    status: 'Unknown'
  };

  await db.set(node.id + '_node', node); 
  const updatedNode = await checkNodeStatus(node);
  res.status(201).send(updatedNode);
});

module.exports = router;